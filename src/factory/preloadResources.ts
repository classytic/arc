/**
 * preloadResources — static resource preloading via `import.meta.glob`.
 *
 * Available from two subpaths — pick whichever fits the caller's intent:
 *   - `@classytic/arc/factory` — production-shaped sibling of `loadResources`
 *     (use this when wiring compliance smokes against a host's `createApp`).
 *   - `@classytic/arc/testing` — compatibility export under the testing namespace
 *     (use this from inside vitest setup files / unit-test fixtures).
 *
 * `loadResources()` covers production and most vitest setups. Reach for this
 * when its DYNAMIC import fails: a resource doing engine init at module
 * top-level (the engine must exist first), or vitest's loader chain not
 * resolving .js→.ts through transitive `node_modules`. Vite rewrites
 * `import.meta.glob` at transform time, so every match goes through the normal
 * transform pipeline instead.
 *
 * `eager: true` evaluates at import time of the calling file. Use
 * `preloadResourcesAsync` (and drop `eager`) when resources need a bootstrap to
 * run first.
 *
 * @example
 * ```typescript
 * export const preloadedResources = preloadResources(
 *   import.meta.glob('../../src/resources/**\/*.resource.ts',
 *                    { eager: true, import: 'default' }),
 * );
 * const app = await createApp({ resources: preloadedResources });
 * ```
 */

import type { ResourceLike } from "./loadResources.js";

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
