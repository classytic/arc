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

export interface LoadResourcesOptions {
  /** File pattern suffix (default: '.resource'). Matches `*.resource.{ts,js,mts,mjs}`. */
  suffix?: string;
  /** Recurse into subdirectories (default: true) */
  recursive?: boolean;
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
   * Suppress warning logs for skipped/failed files.
   * Useful when your resources directory contains factory files or helpers
   * that don't export a resource (e.g., `account.resource.ts` exporting a factory).
   *
   * @default false
   */
  silent?: boolean;
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
export async function loadResources(
  dir: string,
  options: LoadResourcesOptions = {},
): Promise<ResourceLike[]> {
  const { suffix = ".resource", recursive = true, exclude, include, silent = false } = options;
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
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        let mod: Record<string, unknown>;
        try {
          // file:// URL goes through vitest/tsx loader hooks which resolve
          // .js→.ts for the ENTIRE import chain (nested imports included).
          // Bare import(path) only hooks the top-level file in vitest —
          // nested .js imports fall through to Node's native resolver and fail.
          mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
        } catch (_importErr) {
          // Fallback to bare path for runtimes where file:// URL doesn't work
          // (e.g., some bundlers, Bun, edge runtimes).
          mod = (await import(file)) as Record<string, unknown>;
        }
        return { file, mod };
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        // Detect .js extension resolution failures common in TypeScript ESM projects.
        // When running via vitest/tsx, .js→.ts resolution is handled by the loader.
        // When running via raw Node.js, it fails. Provide actionable guidance.
        if (code === "ERR_MODULE_NOT_FOUND" && msg.includes(".js")) {
          failed.push(
            `${file}: ${msg}\n` +
              "    Hint: This file uses .js extension imports (TypeScript ESM convention).\n" +
              "    In production, ensure your build compiles .ts→.js before loadResources() runs.\n" +
              "    In tests, use vitest/tsx which resolves .js→.ts automatically.",
          );
        } else {
          failed.push(`${file}: ${msg}`);
        }
        return null;
      }
    }),
  );

  // Filter and validate — deterministic order preserved (files were pre-sorted)
  const resources: ResourceLike[] = [];

  for (const result of results) {
    if (!result) continue;

    const resource = (result.mod.default ?? result.mod.resource) as ResourceLike | undefined;

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

  // Log diagnostics to stderr (available before Fastify logger exists)
  if (!silent) {
    if (failed.length) {
      console.warn(`[arc] loadResources: ${failed.length} file(s) failed to import:`);
      for (const f of failed) console.warn(`  - ${f}`);
    }
    if (skipped.length) {
      console.warn(
        `[arc] loadResources: ${skipped.length} file(s) skipped (no default export with toPlugin):`,
      );
      for (const f of skipped) console.warn(`  - ${f}`);
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
