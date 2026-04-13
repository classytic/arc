/**
 * Arc CLI - Introspect Command
 *
 * Shows all registered resources and their configuration.
 * Requires an entry file that exports defineResource() results.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ResourceRegistry } from "../../registry/index.js";
import type { RegistryEntry } from "../../types/index.js";

function describePermission(value: unknown): string {
  if (!value) return "none";
  if (typeof value === "function") {
    return value.name ? `${value.name}()` : "[anonymous permission function]";
  }
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "object") return "[permission object]";
  return String(value);
}

export async function introspect(args: string[]): Promise<void> {
  console.log("Introspecting Arc resources...\n");

  try {
    const entryPath = args[0];
    if (!entryPath) {
      console.log("Usage: arc introspect <entry-file>\n");
      console.log("Where entry-file exports your defineResource() results.");
      console.log("Example: arc introspect ./src/resources.js");
      return;
    }

    // Dynamically import user's entry file (pathToFileURL needed for Windows)
    const entryFileUrl = pathToFileURL(resolve(process.cwd(), entryPath)).href;
    const entryModule = await import(entryFileUrl);

    // Collect ResourceDefinition objects from exports (they have _registryMeta + toPlugin)
    // Also handles arrays of resources (e.g. `export const resources = [r1, r2]`)
    const registry = new ResourceRegistry();
    let registered = 0;

    function tryRegister(value: unknown): void {
      if (
        value &&
        typeof value === "object" &&
        "name" in value &&
        "_registryMeta" in value &&
        "toPlugin" in value
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
      console.log("No resource definitions found in entry file.");
      console.log("\nMake sure your file exports defineResource() results:");
      console.log("  export const productResource = defineResource({ ... });");
      return;
    }

    const resources: RegistryEntry[] = registry.getAll();

    console.log(`Found ${resources.length} resource(s):\n`);

    resources.forEach((resource, index) => {
      console.log(`${index + 1}. ${resource.name}`);
      console.log(`   Display Name: ${resource.displayName}`);
      console.log(`   Prefix: ${resource.prefix}`);
      console.log(`   Module: ${resource.module || "none"}`);

      if (resource.permissions) {
        console.log(`   Permissions:`);
        Object.entries(resource.permissions).forEach(([op, permission]) => {
          console.log(`     ${op}: ${describePermission(permission)}`);
        });
      }

      if (resource.presets && resource.presets.length > 0) {
        console.log(`   Presets: ${resource.presets.join(", ")}`);
      }

      if (resource.customRoutes && resource.customRoutes.length > 0) {
        console.log(`   Additional Routes: ${resource.customRoutes.length}`);
      }

      console.log("");
    });

    // Summary
    const stats = registry.getStats();
    console.log("Summary:");
    console.log(`  Total Resources: ${stats.totalResources}`);
    console.log(`  With Presets: ${resources.filter((r) => r.presets?.length > 0).length}`);
    console.log(
      `  With Custom Routes: ${resources.filter((r) => r.customRoutes && r.customRoutes.length > 0).length}`,
    );
  } catch (error: unknown) {
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }
}
