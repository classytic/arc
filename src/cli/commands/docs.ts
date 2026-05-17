/**
 * Arc CLI - Docs Command
 *
 * Export OpenAPI specification from registered resources.
 * Requires an entry file that exports defineResource() results.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildOpenApiSpec } from "../../docs/openapi.js";
import type { RegistryEntry } from "../../types/index.js";
import { loadResourcesFromEntry } from "../utils/loadResourcesFromEntry.js";

interface ParsedDocsArgs {
  entryPath?: string;
  outputPath: string;
}

function parseDocsArgs(args: string[]): ParsedDocsArgs {
  const outputPath = args.find((a) => a.endsWith(".json")) ?? "./openapi.json";
  const entryPath = args.find((a) => !a.endsWith(".json"));
  return { entryPath, outputPath };
}

export async function exportDocs(args: string[]): Promise<void> {
  const { entryPath, outputPath } = parseDocsArgs(args);

  console.log("Exporting OpenAPI specification...\n");

  if (!entryPath) {
    throw new Error(
      "Missing entry file.\n\nUsage: arc docs <entry-file> [output.json]\nExample: arc docs ./src/resources.js ./openapi.json",
    );
  }

  const { registry, registered } = await loadResourcesFromEntry(entryPath);

  if (registered === 0) {
    throw new Error(
      "No resource definitions found in entry file.\nMake sure your file exports defineResource() results:\n  export const productResource = defineResource({ ... });",
    );
  }

  const resources: RegistryEntry[] = registry.getAll();

  const spec = buildOpenApiSpec(resources, {
    title: "Arc API",
    version: "1.0.0",
    description: "Auto-generated from Arc resources",
  });

  // Write to file (resolve handles both relative and absolute paths)
  const fullPath = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(spec, null, 2));

  console.log(`OpenAPI spec exported to: ${fullPath}`);
  console.log(`\nResources included: ${resources.length}`);
  console.log(`Total endpoints: ${Object.keys(spec.paths).length}`);
}
