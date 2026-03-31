/**
 * @classytic/arc — MCP Schema Discovery Resources
 *
 * Registers MCP Resources so AI agents can discover available
 * resources and field schemas before calling tools.
 *
 * - arc://schemas          → overview of all resources
 * - arc://schemas/{name}   → detailed schema for a specific resource
 */

import type { ResourceDefinition } from "../../core/defineResource.js";
import type { McpServerInstance } from "./createMcpServer.js";
import type { CrudOperation } from "./types.js";

// ============================================================================
// Main
// ============================================================================

/**
 * Register MCP Resources for schema discovery.
 */
export function registerSchemaResources(
  server: McpServerInstance | unknown,
  resources: ResourceDefinition[],
  overrides?: Record<string, { operations?: CrudOperation[] }>,
): void {
  const srv = server as McpServerInstance;

  // ── arc://schemas — all resources overview ──
  srv.resource(
    "schemas",
    "arc://schemas",
    {
      title: "Arc Resource Schemas",
      description: "All available resources",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "arc://schemas",
          mimeType: "application/json",
          text: JSON.stringify(
            resources.map((r) => ({
              name: r.name,
              displayName: r.displayName,
              fieldCount: r.schemaOptions?.fieldRules
                ? Object.keys(r.schemaOptions.fieldRules).length
                : 0,
              operations: getOps(r, overrides?.[r.name]?.operations),
              presets: r._appliedPresets ?? [],
            })),
            null,
            2,
          ),
        },
      ],
    }),
  );

  // ── arc://schemas/{name} — per-resource detail ──
  for (const r of resources) {
    const uri = `arc://schemas/${r.name}`;
    const schemaOpts = r.schemaOptions as Record<string, unknown> | undefined;

    srv.resource(
      `schema-${r.name}`,
      uri,
      {
        title: `${r.displayName} Schema`,
        description: `Schema for ${r.displayName}`,
        mimeType: "application/json",
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                name: r.name,
                displayName: r.displayName,
                operations: getOps(r, overrides?.[r.name]?.operations),
                fields: r.schemaOptions?.fieldRules ?? {},
                filterableFields: (schemaOpts?.filterableFields as string[]) ?? [],
                presets: r._appliedPresets ?? [],
              },
              null,
              2,
            ),
          },
        ],
      }),
    );
  }
}

function getOps(r: ResourceDefinition, override?: CrudOperation[]): CrudOperation[] {
  const all: CrudOperation[] = ["list", "get", "create", "update", "delete"];
  let ops = all.filter((op) => !r.disableDefaultRoutes && !r.disabledRoutes?.includes(op));
  if (override) ops = ops.filter((op) => override.includes(op));
  return ops;
}
