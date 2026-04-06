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
 * const app = await createApp({
 *   resources: await loadResources('./src/resources'),
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Minimal resource interface — anything with toPlugin() */
interface ResourceLike {
  toPlugin: () => unknown;
  name?: string;
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
}

/**
 * Scan a directory for resource files and import their default exports.
 *
 * @param dir - Directory path (relative to cwd or absolute)
 * @param options - Pattern and recursion options
 * @returns Array of resource definitions (anything with `.toPlugin()`)
 */
export async function loadResources(
  dir: string,
  options: LoadResourcesOptions = {},
): Promise<ResourceLike[]> {
  const { suffix = ".resource", recursive = true, exclude, include } = options;
  const absDir = resolve(dir);
  const pattern = new RegExp(`${escapeRegex(suffix)}\\.(ts|js|mts|mjs)$`);

  const files = await collectFiles(absDir, pattern, recursive);
  files.sort(); // deterministic registration order (alphabetical)

  const includeSet = include ? new Set(include) : null;
  const excludeSet = exclude ? new Set(exclude) : null;

  const resources: ResourceLike[] = [];

  const skipped: string[] = [];
  const failed: string[] = [];

  for (const file of files) {
    const fileUrl = pathToFileURL(file).href;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(fileUrl)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push(`${file}: ${msg}`);
      continue;
    }

    // Accept default export or named 'resource' export
    const resource = (mod.default ?? mod.resource) as ResourceLike | undefined;

    if (!resource || typeof resource.toPlugin !== "function") {
      skipped.push(file);
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
