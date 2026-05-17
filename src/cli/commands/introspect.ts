/**
 * Arc CLI - Introspect Command
 *
 * Shows all registered resources and their configuration.
 * Requires an entry file that exports defineResource() results.
 */

import type { RegistryEntry } from "../../types/index.js";
import { loadResourcesFromEntry } from "../utils/loadResourcesFromEntry.js";

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

  const entryPath = args[0];
  if (!entryPath) {
    console.log("Usage: arc introspect <entry-file>\n");
    console.log("Where entry-file exports your defineResource() results.");
    console.log("Example: arc introspect ./src/resources.js");
    return;
  }

  const { registry, registered } = await loadResourcesFromEntry(entryPath);

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

    // Tenancy + cascade line. Shown when the resource declares tenant
    // scoping OR declares an `onTenantDelete` strategy, so single-tenant
    // resources don't clutter the output with `tenantField: undefined`.
    const tf = resource.tenantField;
    const purge = resource.resolvedTenantPurge;
    if (tf !== undefined || purge) {
      const parts: string[] = [];
      if (tf === false) {
        parts.push("tenantField: false (company-wide)");
      } else if (typeof tf === "string") {
        parts.push(`tenantField: ${tf}`);
      }
      if (purge && purge.source !== "disabled") {
        // Echo the resolved strategy + source so audit reads "what runs on
        // org-delete?" off one line instead of grepping `onTenantDelete`.
        parts.push(`onOrgDelete: ${purge.strategy.type} (${purge.source})`);
      }
      if (parts.length > 0) console.log(`   Tenancy: ${parts.join(" · ")}`);
    }

    if (resource.customRoutes && resource.customRoutes.length > 0) {
      console.log(`   Additional Routes: ${resource.customRoutes.length}`);
    }

    if (resource.actions && resource.actions.length > 0) {
      const fallback = resource.actionPermissions
        ? ` (fallback: ${describePermission(resource.actionPermissions)})`
        : "";
      // 2.15.5: mark id-less actions with a "@/action" suffix so the
      // mount point is visible at a glance. Id-bound actions stay bare
      // (the legacy default — no need to clutter every line).
      const names = resource.actions
        .map((a) => (a.id === false ? `${a.name} @/action` : a.name))
        .join(", ");
      console.log(`   Actions: ${names}${fallback}`);
    }

    if (resource.aggregations && resource.aggregations.length > 0) {
      console.log(`   Aggregations: ${resource.aggregations.map((a) => a.name).join(", ")}`);
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
  console.log(
    `  With Actions: ${resources.filter((r) => r.actions && r.actions.length > 0).length}`,
  );
  console.log(
    `  With Aggregations: ${resources.filter((r) => r.aggregations && r.aggregations.length > 0).length}`,
  );
  // Cascade summary — answers the audit question "how many resources
  // will cascade on org-delete?" without grepping the source. Matches
  // exactly what `cascadeDeleteForOrganization` will iterate.
  const cascadeCount = resources.filter(
    (r) => r.resolvedTenantPurge && r.resolvedTenantPurge.source !== "disabled",
  ).length;
  console.log(`  Cascading on Org-Delete: ${cascadeCount}`);
}
