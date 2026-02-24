/**
 * Arc Auto-Discovery Plugin
 *
 * Automatically discovers and registers resource files matching a glob pattern.
 * Eliminates manual resource registration boilerplate.
 *
 * This is a SEPARATE subpath import — only loaded when explicitly used:
 *   import { discoveryPlugin, discoverResources } from '@classytic/arc/discovery';
 *
 * Serverless-safe: only runs at startup, no persistent process needed.
 *
 * @example
 * ```typescript
 * import { discoveryPlugin } from '@classytic/arc/discovery';
 *
 * // Auto-discovers all *.resource.ts files
 * await fastify.register(discoveryPlugin, {
 *   paths: ['./src/modules'],
 *   pattern: '**\/*.resource.{ts,js}',
 * });
 *
 * // Or use the helper directly
 * import { discoverResources } from '@classytic/arc/discovery';
 *
 * const resources = await discoverResources({
 *   paths: ['./src/modules'],
 *   pattern: '**\/*.resource.{ts,js}',
 * });
 *
 * for (const resource of resources) {
 *   await fastify.register(resource.toPlugin());
 * }
 * ```
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

// ============================================================================
// Types
// ============================================================================

/** A discovered resource — must have toPlugin() method */
export interface DiscoverableResource {
  toPlugin(): FastifyPluginAsync;
  name?: string;
  definition?: { name: string };
}

export interface DiscoveryOptions {
  /** Directories to scan (relative to cwd or absolute) */
  paths: string[];
  /**
   * File name pattern to match.
   * Supports simple globs: *.resource.ts, *.resource.js
   * Default: '*.resource.{ts,js}'
   */
  pattern?: string;
  /** Export name to look for in each file (default: 'default' then first ResourceDefinition) */
  exportName?: string;
  /** Filter function to include/exclude discovered resources */
  filter?: (resource: DiscoverableResource, filePath: string) => boolean;
  /** Called for each discovered resource (for logging) */
  onDiscover?: (name: string, filePath: string) => void;
  /** Whether to scan recursively (default: true) */
  recursive?: boolean;
}

export interface DiscoveryPluginOptions extends DiscoveryOptions {
  /** URL prefix applied to all discovered resources */
  prefix?: string;
}

// ============================================================================
// File Discovery (pure filesystem, no glob library needed)
// ============================================================================

/**
 * Match a filename against a simple pattern.
 * Supports: *.resource.ts, *.resource.js, *.resource.{ts,js}
 */
function matchPattern(filename: string, pattern: string): boolean {
  // Expand {ts,js} brace patterns
  if (pattern.includes('{') && pattern.includes('}')) {
    const match = pattern.match(/\{([^}]+)\}/);
    if (match) {
      const alternatives = match[1]!.split(',').map((s) => s.trim());
      return alternatives.some((alt) => {
        const expanded = pattern.replace(match[0], alt);
        return matchPattern(filename, expanded);
      });
    }
  }

  // Simple wildcard: *.resource.ts → any file ending with .resource.ts
  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1);
    return filename.endsWith(suffix);
  }

  // Exact match
  return filename === pattern;
}

/**
 * Recursively scan directories for files matching a pattern.
 */
async function scanDirectory(
  dir: string,
  pattern: string,
  recursive: boolean
): Promise<string[]> {
  const results: string[] = [];
  const resolvedDir = resolve(dir);

  const entries = await readdir(resolvedDir, { withFileTypes: true }).catch(
    () => [] as { name: string; isFile(): boolean; isDirectory(): boolean }[],
  );

  for (const entry of entries) {
    const fullPath = join(resolvedDir, String(entry.name));

    if (entry.isDirectory() && recursive) {
      const nested = await scanDirectory(fullPath, pattern, recursive);
      results.push(...nested);
    } else if (entry.isFile()) {
      // Strip any path prefix from pattern (e.g., **/*.resource.ts → *.resource.ts)
      const filePattern = pattern.replace(/^\*\*\//, '');
      if (matchPattern(String(entry.name), filePattern)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

// ============================================================================
// Resource Discovery
// ============================================================================

/**
 * Discover and import resource files.
 *
 * @returns Array of discovered resources with their file paths
 */
export async function discoverResources(
  options: DiscoveryOptions
): Promise<Array<{ resource: DiscoverableResource; filePath: string }>> {
  const {
    paths,
    pattern = '*.resource.{ts,js}',
    exportName,
    filter,
    onDiscover,
    recursive = true,
  } = options;

  const discovered: Array<{ resource: DiscoverableResource; filePath: string }> = [];

  // Scan all directories
  const allFiles: string[] = [];
  for (const dir of paths) {
    const files = await scanDirectory(dir, pattern, recursive);
    allFiles.push(...files);
  }

  // Sort for deterministic registration order
  allFiles.sort();

  // Import each file and extract the resource
  for (const filePath of allFiles) {
    const ext = extname(filePath);
    // Only import .js and .mjs files (compiled output). .ts files need a loader.
    // In development with tsx/ts-node, .ts files work too.
    const fileUrl = pathToFileURL(filePath).href;

    let module: Record<string, unknown>;
    try {
      module = await import(fileUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to import resource file: ${filePath}\n${message}`);
    }

    // Find the resource export
    let resource: DiscoverableResource | null = null;

    // 1. Check specific export name
    if (exportName && module[exportName]) {
      resource = module[exportName] as DiscoverableResource;
    }

    // 2. Check default export
    if (!resource && module.default && typeof (module.default as Record<string, unknown>).toPlugin === 'function') {
      resource = module.default as DiscoverableResource;
    }

    // 3. Search for first export with toPlugin()
    if (!resource) {
      for (const value of Object.values(module)) {
        if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).toPlugin === 'function') {
          resource = value as DiscoverableResource;
          break;
        }
      }
    }

    if (!resource) {
      throw new Error(
        `No resource found in: ${filePath}\n` +
        'Resource files must export an object with a toPlugin() method.\n' +
        'Use defineResource() or export the resource as default.'
      );
    }

    // Apply filter
    if (filter && !filter(resource, filePath)) {
      continue;
    }

    const name = resource.definition?.name ?? resource.name ?? filePath;
    onDiscover?.(name, filePath);
    discovered.push({ resource, filePath });
  }

  return discovered;
}

// ============================================================================
// Fastify Plugin
// ============================================================================

const discoveryPluginImpl: FastifyPluginAsync<DiscoveryPluginOptions> = async (
  fastify: FastifyInstance,
  options: DiscoveryPluginOptions
) => {
  const { prefix, ...discoveryOptions } = options;

  const discovered = await discoverResources({
    ...discoveryOptions,
    onDiscover: discoveryOptions.onDiscover ?? ((name, filePath) => {
      fastify.log.debug({ resource: name, file: filePath }, 'Auto-discovered resource');
    }),
  });

  // Register all discovered resources
  for (const { resource } of discovered) {
    const plugin = resource.toPlugin();
    if (prefix) {
      await fastify.register(plugin, { prefix });
    } else {
      await fastify.register(plugin);
    }
  }

  fastify.log.debug(
    `Auto-discovery: registered ${discovered.length} resource(s)`
  );
};

/** Auto-discovery plugin for Arc resources */
export const discoveryPlugin: FastifyPluginAsync<DiscoveryPluginOptions> = discoveryPluginImpl;
export default discoveryPlugin;
