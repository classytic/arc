/**
 * loadResources — Auto-discover resource files from a directory.
 *
 * Scans for `*.resource.{ts,js,mts,mjs}` files, imports each,
 * and collects their default exports. No barrel file needed.
 *
 * @example
 * ```ts
 * import { createApp, loadResources } from '@classytic/arc/factory';
 *
 * // Recommended: import.meta.url — works in both src/ (dev) and dist/ (prod)
 * const app = await createApp({
 *   resources: await loadResources(import.meta.url),
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
 * });
 *
 * // Or explicit path (must match runtime layout)
 * const app2 = await createApp({
 *   resources: await loadResources('./src/resources'),
 * });
 * ```
 *
 * File convention:
 * ```
 * src/resources/
 *   product/product.resource.ts    → export default defineResource({ name: 'product', ... })
 *   order/order.resource.ts        → export default defineResource({ name: 'order', ... })
 * ```
 */

import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { arcLog } from "../logger/index.js";

/**
 * Resource interface — the contract between `loadResources`/`createApp` and resource definitions.
 *
 * Matches the shape of `ResourceDefinition` from `defineResource()` without requiring
 * the import. All properties except `toPlugin` are optional so plain objects work too:
 *
 * ```typescript
 * // Full resource (from defineResource)
 * const product = defineResource({ name: 'product', ... }); // satisfies ResourceLike
 *
 * // Minimal resource (plain object)
 * const simple: ResourceLike = { name: 'ping', toPlugin: () => () => {} };
 * ```
 *
 * **DO NOT add an index signature** (`[key: string]: unknown`) to this interface.
 * Class instances (like `ResourceDefinition`) don't implicitly carry index signatures,
 * so adding one here makes `ResourceDefinition` *unassignable* to `ResourceLike` —
 * the exact opposite of the intent. TypeScript's structural typing already allows
 * classes with extra properties to satisfy this interface without an index signature.
 */
export interface ResourceLike {
  /** Plugin factory — called by createApp to register routes */
  toPlugin: () => unknown;
  /** Resource name (used for route generation, logging, duplicate detection) */
  name?: string;
  /** Route prefix (default: `/${name}s`) */
  prefix?: string;
  /** Skip the global `resourcePrefix` from createApp — register at root */
  skipGlobalPrefix?: boolean;
  /** Display name for docs/OpenAPI */
  displayName?: string;
  /** Applied preset names */
  _appliedPresets?: string[];
}

/**
 * Resource module — what a `.resource.ts` file's default (or named) export
 * may resolve to.
 *
 * Two shapes accepted:
 *   1. **Plain `ResourceLike`** — the result of `defineResource({...})`.
 *      Used as-is; no engine wiring needed.
 *   2. **Factory `(ctx: TContext) => ResourceLike | Promise<ResourceLike>`**
 *      — a function arc calls with the `context` from `LoadResourcesOptions`.
 *      Eliminates the parallel `createXResource(engine)` factory files +
 *      `exclude: [...]` bookkeeping that engine-bound resources used to need.
 *
 * Detection is by `typeof === 'function'`: `ResourceDefinition` instances
 * (returned by `defineResource()`) are class instances (`typeof === 'object'`),
 * so the two shapes are unambiguous in practice.
 */
export type ResourceModule<TContext = unknown> =
  | ResourceLike
  | ((ctx: TContext) => ResourceLike | Promise<ResourceLike>);

export interface LoadResourcesOptions<TContext = unknown> {
  /** File pattern suffix (default: '.resource'). Matches `*.resource.{ts,js,mts,mjs}`. */
  suffix?: string;
  /** Recurse into subdirectories (default: true) */
  recursive?: boolean;
  /**
   * Context passed to factory-style default exports. Resources whose default
   * export is a function `(ctx) => ResourceLike` are called with this value;
   * plain `ResourceLike` exports are returned unchanged.
   *
   * Use this to thread engine handles into engine-bound resources without
   * creating parallel factory files outside `loadResources`'s sweep:
   *
   * ```ts
   * // category.resource.ts
   * import type { AppContext } from '#core/app/context.js';
   * export default (ctx: AppContext) =>
   *   defineResource({
   *     name: 'category',
   *     adapter: createMongooseAdapter(
   *       ctx.catalog.models.Category,
   *       ctx.catalog.repositories.category,
   *     ),
   *   });
   *
   * // create-arc-app-options.ts
   * resources: async () => {
   *   const [catalog, flow] = await Promise.all([
   *     ensureCatalogEngine(),
   *     ensureFlowEngine(),
   *   ]);
   *   return loadResources(import.meta.url, { context: { catalog, flow } });
   * }
   * ```
   *
   * Backwards compatible — pre-2.11.1 callers omit `context`, plain exports
   * keep working unchanged. Factories that need a context but receive
   * `undefined` should narrow defensively.
   */
  context?: TContext;
  /**
   * Resource names to exclude. Matched against the resource's `.name` property
   * after import, so you use the resource name (not the filename).
   *
   * @example
   * ```ts
   * await loadResources('./src/resources', { exclude: ['debug', 'legacy-report'] })
   * ```
   */
  exclude?: string[];
  /**
   * Resource names to include. When set, only matching resources are returned.
   * Takes priority over `exclude`.
   *
   * @example
   * ```ts
   * // Only load these two resources (useful for testing or microservice splits)
   * await loadResources('./src/resources', { include: ['product', 'order'] })
   * ```
   */
  include?: string[];
  /**
   * Optional logger override for diagnostics. When omitted, warnings flow
   * through arc's standard logger (`arcLog('loadResources')`) — same path
   * as every other arc-internal warning, controlled by `ARC_SUPPRESS_WARNINGS=1`
   * and routable via `configureArcLogger({ writer })`.
   *
   * Pass any object with `warn(msg)` to override (e.g. `fastify.log` —
   * which is what `registerResources` passes automatically when arc's
   * factory triggers auto-discovery via `resourceDir`).
   *
   * Pre-2.11.1 had a `silent: boolean` flag and "silent by default" semantics;
   * both removed. Migration:
   *
   * ```ts
   * // Pre-2.11.1                                // 2.11.1+
   * loadResources(url, { silent: true });            // ARC_SUPPRESS_WARNINGS=1 (env)
   *                                                  //   OR configureArcLogger({ writer })
   * loadResources(url, { silent: !isDev });          // ARC_SUPPRESS_WARNINGS=1 in prod
   * loadResources(url, { logger: pinoAdapter });     // unchanged — still works
   * ```
   */
  logger?: { warn: (msg: string) => void };
}

/**
 * Scan a directory for resource files and import their default exports.
 *
 * Accepts a directory path OR `import.meta.url` (file:// URL).
 * When given a URL, resolves to the directory containing that file —
 * so `loadResources(import.meta.url)` works in both dev (`src/`) and
 * production (`dist/`) without path gymnastics.
 *
 * @param dir - Directory path, or `import.meta.url` (file:// URL resolved to its dirname)
 * @param options - Pattern and recursion options
 * @returns Array of resource definitions (anything with `.toPlugin()`)
 *
 * @example
 * ```ts
 * // Works from both src/ and dist/ — resolves relative to the calling file
 * await loadResources(import.meta.url);
 *
 * // Subdirectory relative to the calling file
 * await loadResources(import.meta.url, { suffix: '.resource' });
 *
 * // Explicit path (must match runtime layout)
 * await loadResources('./src/resources');
 * ```
 */
export async function loadResources<TContext = unknown>(
  dir: string,
  options: LoadResourcesOptions<TContext> = {},
): Promise<ResourceLike[]> {
  const { suffix = ".resource", recursive = true, exclude, include } = options;
  // Accept import.meta.url (file:// URL) — resolve to its parent directory
  const resolvedDir = dir.startsWith("file://") ? dirname(fileURLToPath(dir)) : dir;
  const absDir = resolve(resolvedDir);
  const pattern = new RegExp(`${escapeRegex(suffix)}\\.(ts|js|mts|mjs)$`);

  const files = await collectFiles(absDir, pattern, recursive);
  files.sort(); // deterministic registration order (alphabetical)

  const includeSet = include ? new Set(include) : null;
  const excludeSet = exclude ? new Set(exclude) : null;

  const skipped: string[] = [];
  const failed: string[] = [];

  // Import all files in parallel (like Next.js Promise.all pattern).
  // Each import is independent — one failure doesn't block others.
  // Detect Windows drive letter paths — Node ESM rejects these as bare imports
  // ("D:\..." → Node sees "d:" as a URL scheme and throws). Skip the bare-path
  // fallback on Windows to surface the real error instead.
  const isWindowsPath = (p: string): boolean => /^[a-z]:[\\/]/i.test(p);

  const results = await Promise.all(
    files.map(async (file) => {
      let mod: Record<string, unknown>;
      let primaryError: Error | undefined;
      try {
        // file:// URL goes through vitest/tsx loader hooks which resolve
        // .js→.ts for the ENTIRE import chain (nested imports included).
        // Bare import(path) only hooks the top-level file in vitest —
        // nested .js imports fall through to Node's native resolver and fail.
        mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
        return { file, mod };
      } catch (err) {
        primaryError = err as Error;
      }

      // Fallback to bare path for runtimes where file:// URL doesn't work
      // (e.g., some bundlers, Bun, edge runtimes).
      // Skip on Windows: bare paths starting with "D:\..." are rejected by Node
      // ESM as invalid URL schemes — re-throw the original file:// error instead.
      if (!isWindowsPath(file)) {
        try {
          mod = (await import(file)) as Record<string, unknown>;
          return { file, mod };
        } catch {
          // Fallback also failed — fall through to error reporting with primaryError
        }
      }

      const err = primaryError;
      const code = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      // Detect .js extension resolution failures common in TypeScript ESM projects.
      if (code === "ERR_MODULE_NOT_FOUND" && msg.includes(".js")) {
        failed.push(
          `${file}: ${msg}\n` +
            "    Hint: This file uses .js extension imports (TypeScript ESM convention).\n" +
            "    • Production: ensure your build compiles .ts→.js before loadResources() runs.\n" +
            "    • Node.js: use tsx, ts-node/esm, or a build step.\n" +
            "    • Vitest: nested .js→.ts resolution may fail through dynamic imports.\n" +
            "      Workaround: use import.meta.glob to preload resources statically.\n" +
            "      See: https://github.com/classytic/arc/blob/main/docs/production-ops/factory.mdx#vitest-limitation",
        );
      } else {
        failed.push(`${file}: ${msg}`);
      }
      return null;
    }),
  );

  // Filter and validate — deterministic order preserved (files were pre-sorted)
  const resources: ResourceLike[] = [];
  const factoryFailed: string[] = [];

  for (const result of results) {
    if (!result) continue;

    // Resolution order:
    //   1. default export                       (export default defineResource(...))
    //   2. named export 'resource'              (export const resource = ...)
    //   3. ANY named export with toPlugin()     (export const userResource = ...)
    //   4. default export factory function      (export default (ctx) => defineResource(...))
    //
    // The third path supports the common convention `export const fooResource`.
    // We pick the FIRST matching export, so prefer `default` for unambiguous loading.
    //
    // Factory detection (path 4): the default export is a function. Class
    // instances from `defineResource()` are `typeof === 'object'`, so a
    // function-typed default unambiguously means "call me with context".
    // Async factories are awaited.
    let resource: ResourceLike | undefined;

    const rawDefault = result.mod.default;
    if (typeof rawDefault === "function" && !("toPlugin" in (rawDefault as object))) {
      // Path 4 — factory export
      try {
        const built = await (rawDefault as (ctx: TContext | undefined) => unknown)(options.context);
        if (
          built &&
          typeof built === "object" &&
          typeof (built as ResourceLike).toPlugin === "function"
        ) {
          resource = built as ResourceLike;
        } else {
          factoryFailed.push(`${result.file}: factory returned non-resource value`);
          continue;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        factoryFailed.push(`${result.file}: factory threw: ${msg}`);
        continue;
      }
    } else {
      resource = (rawDefault ?? result.mod.resource) as ResourceLike | undefined;

      if (!resource || typeof resource.toPlugin !== "function") {
        // Scan all named exports for one with toPlugin()
        for (const value of Object.values(result.mod)) {
          if (
            value &&
            typeof value === "object" &&
            typeof (value as ResourceLike).toPlugin === "function"
          ) {
            resource = value as ResourceLike;
            break;
          }
        }
      }
    }

    if (!resource || typeof resource.toPlugin !== "function") {
      skipped.push(result.file);
      continue;
    }

    const name = resource.name;
    if (name) {
      if (includeSet && !includeSet.has(name)) continue;
      if (!includeSet && excludeSet?.has(name)) continue;
    }

    resources.push(resource);
  }

  // Log diagnostics: prefer caller-injected logger; fall back to arc's
  // canonical logger so direct callers without a logger get the same
  // visible-by-default behavior as the rest of arc (suppressible via
  // ARC_SUPPRESS_WARNINGS=1, routable via configureArcLogger({ writer })).
  const log = options?.logger ?? arcLog("loadResources");
  if (log) {
    if (failed.length) {
      log.warn(`[arc] loadResources: ${failed.length} file(s) failed to import:`);
      for (const f of failed) log.warn(`  - ${f}`);
    }
    if (factoryFailed.length) {
      log.warn(
        `[arc] loadResources: ${factoryFailed.length} factory export(s) failed (function default that returned non-resource or threw):`,
      );
      for (const f of factoryFailed) log.warn(`  - ${f}`);
    }
    if (skipped.length) {
      log.warn(
        `[arc] loadResources: ${skipped.length} file(s) skipped (no default export with toPlugin):`,
      );
      for (const f of skipped) log.warn(`  - ${f}`);
    }
    // v2.11 — warn when discovery itself yielded nothing. Covers the
    // "host called loadResources() manually and got back []" path that
    // bypasses the resourceDir WARN in registerResources. The reporter's
    // deploy hit exactly this silent case: `loadResources(import.meta.url)`
    // from inside `dist/` resolved to a directory with no `.resource.js`
    // files (wrong build output layout) and returned `[]`; `createApp`
    // booted with only auth routes.
    if (resources.length === 0 && files.length === 0) {
      log.warn(
        `[arc] loadResources: 0 matching files found at "${absDir}" ` +
          `(pattern: *${suffix}.{ts,js,mts,mjs}). ` +
          "Check the path and runtime layout (src/ vs dist/).",
      );
    }
  }

  return resources;
}

// ============================================================================
// Internal
// ============================================================================

async function collectFiles(dir: string, pattern: RegExp, recursive: boolean): Promise<string[]> {
  const results: string[] = [];

  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results; // directory doesn't exist — return empty
  }

  for (const entry of entries) {
    const name = String(entry.name);
    const fullPath = join(dir, name);

    if (entry.isDirectory() && recursive) {
      results.push(...(await collectFiles(fullPath, pattern, recursive)));
    } else if (entry.isFile() && pattern.test(name)) {
      results.push(fullPath);
    }
  }

  return results;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
