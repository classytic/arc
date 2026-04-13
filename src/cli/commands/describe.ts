/**
 * Arc CLI - Describe Command
 *
 * Machine-readable resource metadata for AI agents.
 * Outputs JSON with fields, permissions, pipeline, routes, events —
 * everything an LLM needs to understand and generate code for the API.
 *
 * @example
 * ```bash
 * arc describe ./src/resources.js --json
 * arc describe ./src/resources.js --resource product
 * arc describe ./src/resources.js --pretty
 * ```
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CRUD_OPERATIONS } from "../../constants.js";
import type { ResourceDefinition } from "../../core/defineResource.js";
import type { FieldPermissionMap } from "../../permissions/fields.js";
import type { PermissionCheck } from "../../permissions/types.js";
import type { PipelineConfig, PipelineStep } from "../../pipeline/types.js";
import type {
  AnyRecord,
  EventDefinition,
  MiddlewareConfig,
  RateLimitConfig,
  ResourcePermissions,
  RouteSchemaOptions,
} from "../../types/index.js";

// ---------------------------------------------------------------------------
// Output Schema
// ---------------------------------------------------------------------------

interface EventCatalogEntry {
  name: string;
  version: number;
  description?: string;
  hasSchema: boolean;
  schemaFields: string[];
  requiredFields: string[];
}

interface DescribeOutput {
  $schema: "arc-describe/v1";
  generatedAt: string;
  resources: DescribedResource[];
  eventCatalog?: EventCatalogEntry[];
  stats: DescribeStats;
}

interface DescribedResource {
  name: string;
  displayName: string;
  prefix: string;
  tag: string;
  module?: string;
  adapter: { type: string; name: string } | null;

  permissions: Record<string, PermissionDescription>;
  presets: string[];

  fields?: Record<string, FieldDescription>;
  pipeline?: PipelineDescription;

  routes: RouteDescription[];
  events: EventDescription[];

  schemaOptions?: RouteSchemaOptions;
  rateLimit?: RateLimitConfig | false;
  middlewares: string[];
}

interface PermissionDescription {
  type: "public" | "requireAuth" | "requireRoles" | "custom";
  roles?: readonly string[];
}

interface FieldDescription {
  type: string;
  roles?: readonly string[];
  redactValue?: unknown;
}

interface PipelineDescription {
  guards: PipelineStepDescription[];
  transforms: PipelineStepDescription[];
  interceptors: PipelineStepDescription[];
}

interface PipelineStepDescription {
  name: string;
  operations?: string[];
}

interface RouteDescription {
  method: string;
  path: string;
  operation: string;
  summary?: string;
  description?: string;
  permission?: PermissionDescription;
}

interface EventDescription {
  name: string;
  description?: string;
  hasSchema: boolean;
  hasHandler: boolean;
}

interface DescribeStats {
  totalResources: number;
  totalRoutes: number;
  totalEvents: number;
  totalCatalogedEvents: number;
  totalFields: number;
  presetUsage: Record<string, number>;
  pipelineSteps: number;
}

// ---------------------------------------------------------------------------
// Permission Introspection
// ---------------------------------------------------------------------------

function describePermission(check: unknown): PermissionDescription {
  if (!check || typeof check !== "function") {
    return { type: "custom" };
  }

  const fn = check as PermissionCheck;

  // allowPublic() sets _isPublic = true
  if (fn._isPublic === true) {
    return { type: "public" };
  }

  // requireRoles() sets _roles = [...]
  if (Array.isArray(fn._roles)) {
    return { type: "requireRoles", roles: fn._roles as string[] };
  }

  // requireAuth() — function that checks ctx.user
  // Infer from function source as a best-effort heuristic
  const src = check.toString();
  if (src.includes("ctx.user") && !src.includes("roles") && src.length < 200) {
    return { type: "requireAuth" };
  }

  return { type: "custom" };
}

function describePermissions(perms?: ResourcePermissions): Record<string, PermissionDescription> {
  if (!perms) return {};

  const result: Record<string, PermissionDescription> = {};
  for (const op of CRUD_OPERATIONS) {
    const check = perms[op];
    if (check) {
      result[op] = describePermission(check);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Field Permission Introspection
// ---------------------------------------------------------------------------

function describeFields(
  fieldPerms?: FieldPermissionMap,
): Record<string, FieldDescription> | undefined {
  if (!fieldPerms || Object.keys(fieldPerms).length === 0) return undefined;

  const result: Record<string, FieldDescription> = {};
  for (const [field, perm] of Object.entries(fieldPerms)) {
    const desc: FieldDescription = { type: perm._type };
    if (perm.roles?.length) desc.roles = perm.roles;
    if (perm.redactValue !== undefined) desc.redactValue = perm.redactValue;
    result[field] = desc;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pipeline Introspection
// ---------------------------------------------------------------------------

function describePipeline(pipe?: PipelineConfig): PipelineDescription | undefined {
  if (!pipe) return undefined;

  const steps: PipelineStep[] = [];

  if (Array.isArray(pipe)) {
    steps.push(...pipe);
  } else {
    // Per-operation map — collect all unique steps
    const seen = new Set<string>();
    for (const opSteps of Object.values(pipe)) {
      if (Array.isArray(opSteps)) {
        for (const step of opSteps) {
          const key = `${step._type}:${step.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            steps.push(step);
          }
        }
      }
    }
  }

  if (steps.length === 0) return undefined;

  const guards: PipelineStepDescription[] = [];
  const transforms: PipelineStepDescription[] = [];
  const interceptors: PipelineStepDescription[] = [];

  for (const step of steps) {
    const desc: PipelineStepDescription = { name: step.name };
    if (step.operations?.length) desc.operations = [...step.operations];

    switch (step._type) {
      case "guard":
        guards.push(desc);
        break;
      case "transform":
        transforms.push(desc);
        break;
      case "interceptor":
        interceptors.push(desc);
        break;
    }
  }

  return { guards, transforms, interceptors };
}

// ---------------------------------------------------------------------------
// Route Introspection
// ---------------------------------------------------------------------------

function describeRoutes(resource: ResourceDefinition<unknown>): RouteDescription[] {
  const routes: RouteDescription[] = [];

  // Default CRUD routes
  if (!resource.disableDefaultRoutes) {
    const disabled = new Set(resource.disabledRoutes ?? []);
    const crudOps = [
      { method: "GET", suffix: "", op: "list" },
      { method: "GET", suffix: "/:id", op: "get" },
      { method: "POST", suffix: "", op: "create" },
      { method: "PATCH", suffix: "/:id", op: "update" },
      { method: "DELETE", suffix: "/:id", op: "delete" },
    ] as const;

    for (const { method, suffix, op } of crudOps) {
      if (!disabled.has(op)) {
        const route: RouteDescription = {
          method,
          path: `${resource.prefix}${suffix}`,
          operation: op,
        };
        const perm = resource.permissions[op];
        if (perm) route.permission = describePermission(perm);
        routes.push(route);
      }
    }
  }

  // Custom routes
  for (const ar of resource.routes ?? []) {
    routes.push({
      method: ar.method,
      path: `${resource.prefix}${ar.path}`,
      operation: typeof ar.handler === "string" ? ar.handler : "custom",
      summary: ar.summary,
      description: ar.description,
      permission: describePermission(ar.permissions),
    });
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Event Introspection
// ---------------------------------------------------------------------------

function describeEvents(
  resourceName: string,
  events?: Record<string, EventDefinition>,
): EventDescription[] {
  if (!events) return [];

  return Object.entries(events).map(([action, def]) => ({
    name: `${resourceName}:${action}`,
    description: def.description,
    hasSchema: !!def.schema,
    hasHandler: !!def.handler,
  }));
}

// ---------------------------------------------------------------------------
// Middleware Introspection
// ---------------------------------------------------------------------------

function describeMiddlewares(middlewares?: MiddlewareConfig): string[] {
  if (!middlewares) return [];

  const ops: string[] = [];
  for (const [op, handlers] of Object.entries(middlewares)) {
    if (handlers?.length) {
      ops.push(`${op}(${handlers.length})`);
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Main Describe Function
// ---------------------------------------------------------------------------

function describeResource(
  resource: ResourceDefinition<unknown>,
  module?: string,
): DescribedResource {
  return {
    name: resource.name,
    displayName: resource.displayName,
    prefix: resource.prefix,
    tag: resource.tag,
    module,

    adapter: resource.adapter ? { type: resource.adapter.type, name: resource.adapter.name } : null,

    permissions: describePermissions(resource.permissions),
    presets: resource._appliedPresets ?? [],

    fields: describeFields(resource.fields),
    pipeline: describePipeline(resource.pipe),

    routes: describeRoutes(resource),
    events: describeEvents(resource.name, resource.events),

    schemaOptions:
      Object.keys(resource.schemaOptions ?? {}).length > 0 ? resource.schemaOptions : undefined,
    rateLimit: resource.rateLimit,
    middlewares: describeMiddlewares(resource.middlewares),
  };
}

// ---------------------------------------------------------------------------
// CLI Entry
// ---------------------------------------------------------------------------

export async function describe(args: string[]): Promise<void> {
  try {
    // Parse flags
    const flags = new Set(args.filter((a) => a.startsWith("--")));
    const positional = args.filter((a) => !a.startsWith("--"));
    const pretty =
      flags.has("--pretty") || (!flags.has("--json") && (process.stdout.isTTY ?? true));
    const filterResource = positional[1]; // optional resource name filter

    const entryPath = positional[0];
    if (!entryPath) {
      console.log("Usage: arc describe <entry-file> [resource-name] [--json] [--pretty]\n");
      console.log("Outputs machine-readable JSON metadata for AI agents.\n");
      console.log("Options:");
      console.log("  --json     Output compact JSON (default if piped)");
      console.log("  --pretty   Output formatted JSON (default if terminal)");
      console.log("\nExamples:");
      console.log("  arc describe ./src/resources.js");
      console.log("  arc describe ./src/resources.js product");
      console.log("  arc describe ./src/resources.js --json | jq .");
      return;
    }

    // Dynamically import user's entry file (pathToFileURL needed for Windows)
    const entryFileUrl = pathToFileURL(resolve(process.cwd(), entryPath)).href;
    const entryModule = await import(entryFileUrl);

    // Collect ResourceDefinition objects and EventRegistry instances
    // Also handles arrays of resources (e.g. `export const resources = [r1, r2]`)
    const resources: ResourceDefinition<unknown>[] = [];
    let eventRegistry:
      | {
          catalog: () => ReadonlyArray<{
            name: string;
            version: number;
            description?: string;
            schema?: Record<string, unknown>;
          }>;
        }
      | undefined;

    function tryCollect(value: unknown): void {
      if (
        value &&
        typeof value === "object" &&
        "name" in value &&
        "_registryMeta" in value &&
        "toPlugin" in value
      ) {
        resources.push(value as ResourceDefinition<unknown>);
      }
    }

    function tryCollectRegistry(value: unknown): void {
      if (
        value &&
        typeof value === "object" &&
        "catalog" in value &&
        "register" in value &&
        "validate" in value &&
        typeof (value as Record<string, unknown>).catalog === "function"
      ) {
        eventRegistry = value as typeof eventRegistry;
      }
    }

    for (const exported of Object.values(entryModule)) {
      if (Array.isArray(exported)) {
        exported.forEach(tryCollect);
      } else {
        tryCollect(exported);
        tryCollectRegistry(exported);
      }
    }

    if (resources.length === 0) {
      throw new Error(
        "No resource definitions found in entry file.\nMake sure your file exports defineResource() results:\n  export const productResource = defineResource({ ... });",
      );
    }

    // Filter to single resource if requested
    const filtered = filterResource
      ? resources.filter((r) => r.name === filterResource)
      : resources;

    if (filterResource && filtered.length === 0) {
      throw new Error(
        `Resource '${filterResource}' not found.\nAvailable: ${resources.map((r) => r.name).join(", ")}`,
      );
    }

    // Build described resources
    const described = filtered.map((r) =>
      describeResource(r, (r._registryMeta as AnyRecord | undefined)?.module as string | undefined),
    );

    // Compute stats
    const presetCounts: Record<string, number> = {};
    let totalPipelineSteps = 0;
    let totalFields = 0;

    for (const res of described) {
      for (const preset of res.presets) {
        presetCounts[preset] = (presetCounts[preset] ?? 0) + 1;
      }
      if (res.pipeline) {
        totalPipelineSteps +=
          res.pipeline.guards.length +
          res.pipeline.transforms.length +
          res.pipeline.interceptors.length;
      }
      if (res.fields) {
        totalFields += Object.keys(res.fields).length;
      }
    }

    // Build event catalog from registry (if found)
    let eventCatalog: EventCatalogEntry[] | undefined;
    if (eventRegistry) {
      const raw = eventRegistry.catalog();
      eventCatalog = raw.map((e) => ({
        name: e.name,
        version: e.version,
        description: e.description,
        hasSchema: !!e.schema,
        schemaFields: e.schema?.properties
          ? Object.keys(e.schema.properties as Record<string, unknown>)
          : [],
        requiredFields: (e.schema?.required as string[]) ?? [],
      }));
    }

    const output: DescribeOutput = {
      $schema: "arc-describe/v1",
      generatedAt: new Date().toISOString(),
      resources: described,
      ...(eventCatalog?.length ? { eventCatalog } : {}),
      stats: {
        totalResources: described.length,
        totalRoutes: described.reduce((sum, r) => sum + r.routes.length, 0),
        totalEvents: described.reduce((sum, r) => sum + r.events.length, 0),
        totalCatalogedEvents: eventCatalog?.length ?? 0,
        totalFields,
        presetUsage: presetCounts,
        pipelineSteps: totalPipelineSteps,
      },
    };

    // Output
    const json = pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);

    console.log(json);
  } catch (error: unknown) {
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }
}
