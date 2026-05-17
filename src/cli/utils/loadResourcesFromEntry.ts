/**
 * Shared loader for CLI commands that need to read a host's resource graph
 * from a built entry file (`introspect`, `docs`, `describe`).
 *
 * Each command historically duplicated the same dance: `pathToFileURL` →
 * dynamic `import()` → walk the module's exports → match anything that
 * looks structurally like a `ResourceDefinition` (carries `name`,
 * `_registryMeta`, `toPlugin`) → register into a fresh `ResourceRegistry`.
 * Extracting the duplication here means a future signature change to
 * the registry surface or the resource-shape sentinel only touches one
 * spot.
 *
 * The structural match (vs `instanceof ResourceDefinition`) is deliberate:
 * the host's entry file is a compiled `dist/` artifact that may have been
 * built against a different arc minor version, so a class-identity check
 * would reject genuinely-compatible objects across version drift.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ResourceRegistry } from "../../registry/index.js";

type ResourceRegisterArgs = Parameters<ResourceRegistry["register"]>;

/**
 * Load the host's entry file, walk its exports, and register every
 * `ResourceDefinition`-shaped value into a fresh `ResourceRegistry`.
 *
 * Returns `{ registry, registered }`:
 *   - `registry` is populated and ready to query (`getAll()`, `getStats()`,
 *     `getIntrospection()`).
 *   - `registered` is the count — callers can short-circuit with a
 *     friendly "no resources found" message when it's zero.
 */
export async function loadResourcesFromEntry(
  entryPath: string,
): Promise<{ registry: ResourceRegistry; registered: number }> {
  // `pathToFileURL` is required on Windows — Node refuses to `import()`
  // a raw `C:\...` path with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
  const entryFileUrl = pathToFileURL(resolve(process.cwd(), entryPath)).href;
  const entryModule = (await import(entryFileUrl)) as Record<string, unknown>;

  const registry = new ResourceRegistry();
  let registered = 0;

  const tryRegister = (value: unknown): void => {
    if (
      value &&
      typeof value === "object" &&
      "name" in value &&
      "_registryMeta" in value &&
      "toPlugin" in value
    ) {
      const resourceLike = value as { _registryMeta?: unknown } & ResourceRegisterArgs[0];
      registry.register(
        resourceLike,
        (resourceLike._registryMeta ?? {}) as ResourceRegisterArgs[1],
      );
      registered++;
    }
  };

  for (const exported of Object.values(entryModule)) {
    if (Array.isArray(exported)) {
      for (const entry of exported) tryRegister(entry);
    } else {
      tryRegister(exported);
    }
  }

  return { registry, registered };
}
