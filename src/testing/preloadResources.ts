/**
 * preloadResources — Vitest helper for static resource preloading
 *
 * `loadResources()` works in production and most vitest setups, but it can fail
 * in two edge cases:
 *
 *   1. Resources that depend on top-level engine init (e.g., `getAccountModel()`
 *      called at module top-level, where the engine must be initialized FIRST)
 *
 *   2. Vitest's loader chain not composing perfectly with dynamic imports for
 *      deeply nested .js→.ts resolution in transitive `node_modules` packages
 *
 * For these cases, use Vite's compile-time `import.meta.glob` to preload
 * resources statically. This bypasses dynamic import entirely — every match
 * goes through vitest's transform pipeline like any other static import.
 *
 * @example
 * ```typescript
 * // tests/setup/preload-resources.ts
 * import { preloadResources } from '@classytic/arc/testing';
 *
 * // Vite rewrites import.meta.glob at transform time into a static map.
 * // eager: true evaluates all resources at import time of THIS file.
 * // Use eager: false if any resource depends on prior bootstrap (engine init).
 * export const preloadedResources = preloadResources(
 *   import.meta.glob('../../src/resources/**\/*.resource.ts', {
 *     eager: true,
 *     import: 'default',
 *   }),
 * );
 * ```
 *
 * @example
 * ```typescript
 * // tests/integration/foo.test.ts
 * import { createApp } from '@classytic/arc/factory';
 * import { preloadedResources } from '../setup/preload-resources.js';
 *
 * const app = await createApp({ resources: preloadedResources });
 * ```
 *
 * @example
 * ```typescript
 * // For deferred loading (when modules need bootstrap to run first):
 * import { preloadResourcesAsync } from '@classytic/arc/testing';
 *
 * // bootstrap engines before loading resources
 * await initAccountingEngine();
 *
 * const resources = await preloadResourcesAsync(
 *   import.meta.glob('../../src/resources/**\/*.resource.ts', { import: 'default' }),
 * );
 * ```
 */

import type { ResourceLike } from "../factory/loadResources.js";

/** Eager glob result: `{ '/path/to/file.ts': resourceModule }` */
type EagerGlobResult = Record<string, unknown>;

/** Lazy glob result: `{ '/path/to/file.ts': () => Promise<unknown> }` */
type LazyGlobResult = Record<string, () => Promise<unknown>>;

/**
 * Normalize an eager `import.meta.glob` result into a `ResourceLike[]`.
 *
 * Accepts either:
 * - `{ import: 'default' }` form: values are the resource directly
 * - default form: values are the full module — picks first export with `toPlugin()`
 *
 * Throws if any module doesn't yield a valid `ResourceLike`.
 */
export function preloadResources(globResult: EagerGlobResult): ResourceLike[] {
  const resources: ResourceLike[] = [];

  for (const [path, value] of Object.entries(globResult)) {
    const resource = pickResource(value);
    if (!resource) {
      throw new Error(
        `preloadResources: ${path} does not export a valid resource.\n` +
          "    Expected: a default export OR a named export with toPlugin().",
      );
    }
    resources.push(resource);
  }

  // Sort by name for deterministic registration order (matches loadResources)
  return resources.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/**
 * Normalize a lazy `import.meta.glob` result into a `Promise<ResourceLike[]>`.
 *
 * Use this when resources depend on prior bootstrap (e.g., engine init) and
 * cannot be evaluated at import time of the preload file.
 */
export async function preloadResourcesAsync(globResult: LazyGlobResult): Promise<ResourceLike[]> {
  const entries = await Promise.all(
    Object.entries(globResult).map(async ([path, loader]) => {
      const value = await loader();
      const resource = pickResource(value);
      if (!resource) {
        throw new Error(
          `preloadResourcesAsync: ${path} does not export a valid resource.\n` +
            "    Expected: a default export OR a named export with toPlugin().",
        );
      }
      return resource;
    }),
  );

  return entries.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

// ── Internal ──

function pickResource(value: unknown): ResourceLike | undefined {
  if (!value || typeof value !== "object") return undefined;

  // If glob was called with { import: 'default' }, value IS the resource
  if (typeof (value as ResourceLike).toPlugin === "function") {
    return value as ResourceLike;
  }

  // Otherwise, value is the full module — try default, then 'resource', then any
  const mod = value as Record<string, unknown>;
  const candidates: unknown[] = [mod.default, mod.resource, ...Object.values(mod)];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof (c as ResourceLike).toPlugin === "function") {
      return c as ResourceLike;
    }
  }
  return undefined;
}
