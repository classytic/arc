/**
 * Arc CLI - Docs Command
 *
 * Export OpenAPI specification from registered resources.
 * Requires an entry file that exports defineResource() results.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ResourceRegistry } from '../../registry/index.js';
import type { RegistryEntry } from '../../types/index.js';
import { buildOpenApiSpec } from '../../docs/openapi.js';

interface ParsedDocsArgs {
  entryPath?: string;
  outputPath: string;
}

function parseDocsArgs(args: string[]): ParsedDocsArgs {
  const outputPath = args.find((a) => a.endsWith('.json')) ?? './openapi.json';
  const entryPath = args.find((a) => !a.endsWith('.json'));
  return { entryPath, outputPath };
}

export async function exportDocs(args: string[]): Promise<void> {
  const { entryPath, outputPath } = parseDocsArgs(args);

  console.log('Exporting OpenAPI specification...\n');

  if (!entryPath) {
    throw new Error(
      'Missing entry file.\n\nUsage: arc docs <entry-file> [output.json]\nExample: arc docs ./src/resources.js ./openapi.json',
    );
  }

  // Dynamically import user's entry file
  const entryFileUrl = pathToFileURL(resolve(process.cwd(), entryPath)).href;
  const entryModule = await import(entryFileUrl);

  // Collect ResourceDefinition objects from exports
  // Also handles arrays of resources (e.g. `export const resources = [r1, r2]`)
  const registry = new ResourceRegistry();
  let registered = 0;

  function tryRegister(value: unknown): void {
    if (
      value &&
      typeof value === 'object' &&
      'name' in value &&
      '_registryMeta' in value &&
      'toPlugin' in value
    ) {
      registry.register(value as any, (value as any)._registryMeta ?? {});
      registered++;
    }
  }

  for (const exported of Object.values(entryModule)) {
    if (Array.isArray(exported)) {
      exported.forEach(tryRegister);
    } else {
      tryRegister(exported);
    }
  }

  if (registered === 0) {
    throw new Error(
      'No resource definitions found in entry file.\nMake sure your file exports defineResource() results:\n  export const productResource = defineResource({ ... });',
    );
  }

  const resources: RegistryEntry[] = registry.getAll();

  const spec = buildOpenApiSpec(resources, {
    title: 'Arc API',
    version: '1.0.0',
    description: 'Auto-generated from Arc resources',
  });

  // Write to file (resolve handles both relative and absolute paths)
  const fullPath = resolve(process.cwd(), outputPath);
  writeFileSync(fullPath, JSON.stringify(spec, null, 2));

  console.log(`OpenAPI spec exported to: ${fullPath}`);
  console.log(`\nResources included: ${resources.length}`);
  console.log(`Total endpoints: ${Object.keys(spec.paths).length}`);
}

export default { exportDocs };
