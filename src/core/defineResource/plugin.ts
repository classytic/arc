/**
 * Resource Fastify plugin builder — Phase 8 of `defineResource()`.
 *
 * `ResourceDefinition.toPlugin()` delegates to `buildResourcePlugin(self)`
 * so the data class stays focused on holding the validated, normalised
 * resource contract. Everything that runs **at Fastify-registration time**
 * lives here:
 *
 *   - shared-state writes (registry, hooks, cache invalidation rules)
 *     guarded by the resource's per-host `_sharedStateRegisteredOn` set so
 *     multi-prefix mounts (`/v1`, `/v2`) don't double-register.
 *   - CRUD route schema synthesis (adapter `OpenApiSchemas` →
 *     `CrudSchemas` + custom-schema deep merge)
 *   - listQuery schema normalization (Fastify/AJV strict-mode-clean shape
 *     for `qs`-parsed bracket notation)
 *   - CRUD router registration via `createCrudRouter`
 *   - dynamic action router registration (`createActionRouter`)
 *   - dynamic aggregation router registration
 *   - lifecycle event emission (`arc.resource.registered`)
 *
 * The schema-synthesis helpers (`buildGeneratedCrudSchemas`,
 * `normalizeListQuerySchema`) are exported so unit tests can pin
 * non-obvious invariants — the most critical one being that `params`
 * schemas are CLONED PER CRUD SLOT. Earlier inline code shared the same
 * `params` object reference across `get`, `delete`, and `update` slots,
 * so any downstream mutation (vendor extensions, AJV `$ref` decoration,
 * description overrides) silently leaked across operations.
 */

import type { FastifyPluginAsync } from "fastify";
import type {
  ActionDefinition,
  ActionsMap,
  AnyRecord,
  CrudController,
  CrudSchemas,
  FastifyWithDecorators,
  PermissionCheck,
  RequestWithExtras,
  ResourceConfig,
} from "../../types/index.js";
import { convertRouteSchema } from "../../utils/schemaConverter.js";
import { hasEvents } from "../../utils/typeGuards.js";
import { resolveActionPermission } from "../actionPermissions.js";
import { createCrudRouter } from "../createCrudRouter.js";
import type { ResourceDefinition } from "./ResourceDefinition.js";

// ============================================================================
// Pure schema-synthesis helpers (exported for unit tests)
// ============================================================================

/**
 * Build the CRUD schema map from the adapter's `OpenApiSchemas` plus
 * any `customSchemas` overrides on the resource.
 *
 * Returns `null` when neither input has anything to contribute, so
 * the caller can pass `undefined` straight to `createCrudRouter`.
 *
 * **Per-slot layering (post-2.12 DX fix).** Adapter auto-gen runs
 * unconditionally — declaring one custom slot (e.g. a richer
 * `create.body`) no longer wholesale-disables generated `get`,
 * `update`, `delete`, and `params` schemas. The pre-fix branch
 * skipped auto-gen entirely whenever `customSchemas` had any entry,
 * which silently flipped four slots from "auto-derived from the
 * adapter's schema generator" to "Fastify default" the moment a
 * host customised one. Now: auto-gen first, then deep-merge
 * customSchemas on top per slot.
 *
 * **`params` cloning is load-bearing.** Three CRUD slots (`get`,
 * `delete`, `update`) need a `params` schema. The previous inline
 * code shared the same reference across all three, so a downstream
 * mutation (e.g. attaching a vendor `description` for OpenAPI
 * tooling) leaked across operations. Each slot now owns its own
 * shallow clone.
 */
export function buildGeneratedCrudSchemas(
  openApi: AnyRecord | undefined,
  customSchemas: AnyRecord | undefined,
): CrudSchemas | null {
  const generated: Record<string, AnyRecord> = {};

  if (openApi) {
    const { createBody, updateBody, params } = openApi;

    if (createBody) {
      generated.create = { body: safeBody(createBody as AnyRecord) };
    }
    if (updateBody) {
      // PATCH semantics: strip `required` so all fields are optional.
      // PUT gets the original with required fields intact.
      const patchBody = { ...(updateBody as AnyRecord) };
      delete patchBody.required;
      generated.update = { body: safeBody(patchBody) };
      if (params) generated.update.params = cloneShallow(params as AnyRecord);
    }
    if (params) {
      generated.get = { params: cloneShallow(params as AnyRecord) };
      generated.delete = { params: cloneShallow(params as AnyRecord) };
      if (!generated.update) generated.update = { params: cloneShallow(params as AnyRecord) };
      else if (!generated.update.params) {
        generated.update.params = cloneShallow(params as AnyRecord);
      }
    }
  }

  let schemas: CrudSchemas | null =
    Object.keys(generated).length > 0 ? (generated as CrudSchemas) : null;

  // Layer customSchemas on top per-slot (Zod schemas auto-convert via
  // `convertRouteSchema`). Deep merge so a custom `body` doesn't
  // erase the auto-generated `params` on the same op, and vice
  // versa. Slots customSchemas doesn't touch keep their auto-gen
  // intact.
  if (customSchemas && Object.keys(customSchemas).length > 0) {
    schemas = schemas ?? {};
    for (const [op, customSchema] of Object.entries(customSchemas)) {
      const key = op as keyof CrudSchemas;
      const converted = convertRouteSchema(customSchema as Record<string, unknown>);
      schemas[key] = schemas[key]
        ? deepMergeSchemas(schemas[key] as AnyRecord, converted as AnyRecord)
        : (converted as AnyRecord);
    }
  }

  return schemas;
}

/**
 * Normalize the listQuery JSON Schema for Fastify/AJV strict-mode use.
 *
 * The `qs` parser turns bracket notation into nested objects/arrays:
 *   `?name[contains]=foo` → `{ name: { contains: "foo" } }`
 *   `?tags[]=a&tags[]=b`  → `{ tags: ["a", "b"] }`
 *   `?populate[author][select]=name` → deeply nested object
 *
 * AJV rejects these against the OpenAPI-friendly `type: "string"`
 * declarations adapters generate. The QueryParser is the source of truth
 * for filter validation/coercion, so we replace each property with a
 * minimal AJV-strict-mode-clean shape: numeric pagination keys keep
 * `type: "integer"` (so `minimum`/`maximum` don't trigger AJV warnings),
 * everything else collapses to `{}`.
 *
 * The original `limit.maximum` is preserved so the parser's configured
 * max stays effective at the AJV layer.
 */
export function normalizeListQuerySchema(listQuerySchema: AnyRecord): AnyRecord {
  const NORMALIZED_PROPS: Record<string, AnyRecord> = {
    page: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1 },
    sort: {},
    search: {},
    select: {},
    after: {},
    populate: {},
    lookup: {},
    aggregate: {},
  };
  const props = listQuerySchema.properties as AnyRecord | undefined;
  const normalizedProps = props ? { ...props } : undefined;
  if (normalizedProps) {
    const originalLimit = normalizedProps.limit as { maximum?: number } | undefined;
    if (originalLimit?.maximum) {
      NORMALIZED_PROPS.limit = {
        ...NORMALIZED_PROPS.limit,
        maximum: originalLimit.maximum,
      };
    }
    for (const key of Object.keys(normalizedProps)) {
      normalizedProps[key] = NORMALIZED_PROPS[key] ?? {};
    }
  }
  return {
    ...listQuerySchema,
    ...(normalizedProps ? { properties: normalizedProps } : {}),
    additionalProperties: listQuerySchema.additionalProperties ?? true,
  };
}

/**
 * Merge two JSON schema branches deeply. Arrays are unioned with
 * deduplication (so combined `required` lists don't duplicate field
 * names); plain-object keys recurse; primitives are overwritten.
 *
 * Exported for the action/CRUD router-config code paths that need to
 * compose user overrides on top of generated schemas.
 */
export function deepMergeSchemas(base: AnyRecord, override: AnyRecord): AnyRecord {
  if (!override) return base;
  if (!base) return override;

  const result: AnyRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value) && Array.isArray(result[key])) {
      result[key] = [...new Set([...(result[key] as unknown[]), ...value])];
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMergeSchemas(result[key] as AnyRecord, value as AnyRecord);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function cloneShallow(value: AnyRecord): AnyRecord {
  return { ...value };
}

function safeBody(schema: AnyRecord): AnyRecord {
  // Body schemas default to additionalProperties:true so the built-in
  // fallback extractor doesn't reject unknown fields. Adapters that want
  // strict rejection can opt in by setting `additionalProperties: false`
  // explicitly — the spread order means an explicit value wins.
  if (schema && typeof schema === "object" && schema.type === "object") {
    return { additionalProperties: true, ...schema };
  }
  return schema;
}

// ============================================================================
// Action router config normalization
// ============================================================================

/**
 * Normalize `ActionsMap` into the `ActionRouterConfig` shape that
 * `createActionRouter` expects.
 *
 * **Permission fallback chain (fail-closed, v2.10.5):** delegated to the
 * shared resolver in `actionPermissions.ts`. The resource-level gate
 * goes into the resolver's slot 2 (`resourceActionPermissions`) — its
 * semantic home — leaving slot 3 (`globalAuth`) reserved for direct
 * `createActionRouter` callers that genuinely have a router-wide gate.
 *
 * The returned `actionPermissions` map is FULLY RESOLVED per action.
 * Earlier versions returned a sparse map plus a `globalAuth` field that
 * `createActionRouter` flattened at request time via `?? globalAuth`.
 * That conflated two different layers in the resolver chain (slot 2 vs.
 * slot 3). Boot-time resolution closes the drift: every action that
 * survives this pass has its effective gate baked into the map, and
 * `createActionRouter`'s request-time `?? globalAuth` becomes a no-op
 * for the defineResource path.
 */
export function normalizeActionsToRouterConfig(
  actions: ActionsMap,
  resourceActionPermissions: PermissionCheck | undefined,
  tag: string,
  resourcePermissions: ResourceConfig<unknown>["permissions"] | undefined,
  resourceName: string,
  log: { warn?: (obj: unknown, msg?: string) => void } | undefined,
): {
  tag: string;
  actions: Record<
    string,
    (id: string, data: Record<string, unknown>, req: RequestWithExtras) => Promise<unknown>
  >;
  actionPermissions: Record<string, PermissionCheck>;
  actionSchemas: Record<string, Record<string, unknown>>;
} {
  const handlers: Record<
    string,
    (id: string, data: Record<string, unknown>, req: RequestWithExtras) => Promise<unknown>
  > = {};
  const permissions: Record<string, PermissionCheck> = {};
  const schemas: Record<string, Record<string, unknown>> = {};

  for (const [name, entry] of Object.entries(actions)) {
    const explicit =
      typeof entry !== "function" && entry.permissions
        ? (entry.permissions as PermissionCheck)
        : undefined;

    if (typeof entry === "function") {
      handlers[name] = entry;
    } else {
      const def = entry as ActionDefinition;
      handlers[name] = def.handler;
      if (def.schema) schemas[name] = def.schema as Record<string, unknown>;
    }

    const effective = resolveActionPermission({
      action: entry,
      resourcePermissions,
      resourceActionPermissions,
      globalAuth: undefined,
    });

    const hitUpdateFallback =
      !explicit &&
      !resourceActionPermissions &&
      effective &&
      effective === resourcePermissions?.update;

    if (hitUpdateFallback) {
      log?.warn?.(
        {
          resource: resourceName,
          action: name,
          fallback: "permissions.update",
        },
        `[Arc] Action '${resourceName}.${name}' has no explicit permission — ` +
          `falling back to the resource's \`permissions.update\` gate. ` +
          `Declare \`actions.${name}.permissions\` (or resource \`actionPermissions\`) to silence this.`,
      );
    }

    if (!effective) {
      throw new Error(
        `[Arc] Resource '${resourceName}': action '${name}' has no permission gate ` +
          `and the resource defines no \`permissions.update\` fallback. ` +
          `Declare one of:\n` +
          `  - \`actions.${name}.permissions: <PermissionCheck>\` (per-action)\n` +
          `  - \`actionPermissions: <PermissionCheck>\` (resource-wide)\n` +
          `  - \`permissions.update: <PermissionCheck>\` (inherited by actions)\n` +
          `Use \`allowPublic()\` if you genuinely want the action unauthenticated.`,
      );
    }

    permissions[name] = effective;
  }

  return {
    tag,
    actions: handlers,
    actionPermissions: permissions,
    actionSchemas: schemas,
  };
}

// ============================================================================
// Plugin builder
// ============================================================================

/**
 * Build the FastifyPluginAsync that materialises a `ResourceDefinition`
 * into routes, hooks, registry entries, and cache invalidation rules.
 *
 * Called once per `ResourceDefinition.toPlugin()`. The returned plugin
 * function captures `resource` in its closure and can be `app.register`-ed
 * any number of times — shared-state writes are idempotent per host
 * Fastify instance via `resource._sharedStateRegisteredOn`.
 */
export function buildResourcePlugin<TDoc>(resource: ResourceDefinition<TDoc>): FastifyPluginAsync {
  return async function resourcePlugin(fastify, _opts): Promise<void> {
    // Shared-state writes (registry, hooks, cache rules) target the ROOT
    // Fastify instance — `arc.hooks` is decorated once and inherited by
    // child encapsulation contexts. Key the idempotency guard by the
    // root so multi-prefix mounts collapse to a single shared-state
    // registration. Routes register inside their own encapsulation pass
    // below — Fastify owns that isolation.
    const sharedRoot = ((fastify as { server?: object }).server ?? fastify) as object;
    const isFirstMount = !resource._sharedStateRegisteredOn.has(sharedRoot);
    if (isFirstMount) resource._sharedStateRegisteredOn.add(sharedRoot);

    const arc = (fastify as FastifyWithDecorators).arc;
    if (isFirstMount && arc?.registry && resource._registryMeta) {
      try {
        arc.registry.register(
          resource as unknown as ResourceDefinition<AnyRecord>,
          resource._registryMeta,
        );
      } catch (err) {
        fastify.log?.warn?.(
          `Failed to register resource '${resource.name}' in registry: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    if (isFirstMount && resource._pendingHooks.length > 0 && arc?.hooks) {
      for (const hook of resource._pendingHooks) {
        arc.hooks.register({
          resource: resource.name,
          operation: hook.operation,
          phase: hook.phase,
          handler: hook.handler as (ctx: {
            resource: string;
            operation: string;
            phase: string;
            data?: AnyRecord;
          }) => AnyRecord | Promise<AnyRecord>,
          priority: hook.priority,
        });
      }
    }

    const registerRule = (fastify as unknown as Record<string, unknown>)
      .registerCacheInvalidationRule;
    if (isFirstMount && resource.cache?.invalidateOn && typeof registerRule === "function") {
      for (const [pattern, tags] of Object.entries(resource.cache.invalidateOn)) {
        (registerRule as (rule: { pattern: string; tags: string[] }) => void)({
          pattern,
          tags,
        });
      }
    }

    await fastify.register(
      async (instance) => {
        const typedInstance = instance as FastifyWithDecorators;

        // CRUD schema synthesis — pure-function pipeline (testable in
        // isolation; see tests/core/resource-plugin-schema-synthesis.test.ts)
        let schemas: CrudSchemas | null = buildGeneratedCrudSchemas(
          resource._registryMeta?.openApiSchemas as AnyRecord | undefined,
          resource.customSchemas as AnyRecord,
        );

        // Apply queryParser's listQuery schema as the Fastify querystring
        // validation schema for the list route. Without this, a hardcoded
        // default (maximum: 100) overrides the parser's configured maxLimit.
        const listQuerySchema = resource._registryMeta?.openApiSchemas?.listQuery;
        if (listQuerySchema) {
          const normalizedSchema = normalizeListQuerySchema(listQuerySchema as AnyRecord);
          schemas = schemas ?? {};
          schemas.list = schemas.list
            ? deepMergeSchemas(
                { querystring: normalizedSchema } as AnyRecord,
                schemas.list as AnyRecord,
              )
            : ({ querystring: normalizedSchema } as AnyRecord);
        }

        // Pass routes as-is to createCrudRouter. String handler resolution
        // and `wrapHandler` derivation (from `!route.raw`) happen inside
        // createCrudRouter.
        createCrudRouter(typedInstance, resource.controller as unknown as CrudController<TDoc>, {
          tag: resource.tag,
          schemas: schemas ?? undefined,
          permissions: resource.permissions,
          middlewares: resource.middlewares,
          routeGuards: resource.routeGuards,
          routes: resource.routes,
          disableDefaultRoutes: resource.disableDefaultRoutes,
          // Spread to a mutable copy — `disabledRoutes` is frozen on the
          // resource (see `tests/core/resource-definition-immutability.test.ts`)
          // but `createCrudRouter` types its option as a mutable array.
          // The router only reads (via `.includes`), so the clone is purely
          // a type-system bridge.
          disabledRoutes: [...resource.disabledRoutes],
          resourceName: resource.name,
          schemaOptions: resource.schemaOptions,
          rateLimit: resource.rateLimit,
          updateMethod: resource.updateMethod,
          pipe: resource.pipe,
          fields: resource.fields,
          // Surfaces on `req.arc.idField` via `buildArcDecorator` — see
          // `core/entityHelpers.ts` for the read-side helpers.
          idField: resource.idField,
        });

        // Register first-class actions (v2.8) — after CRUD routes, inside
        // prefix scope. Actions share every cross-cutting primitive with
        // CRUD via `routerShared`: arc decorator, auth/permission middleware,
        // pipeline execution, idempotency, rate-limit. Resource-level
        // `fields`, `permissions`, `routeGuards`, `pipe`, `rateLimit`, and
        // `schemaOptions` thread through here so an action endpoint that
        // mutates documents applies the same wiring a PATCH would apply.
        if (resource.actions && Object.keys(resource.actions).length > 0) {
          const { createActionRouter } = await import("../createActionRouter.js");
          const actionConfig = normalizeActionsToRouterConfig(
            resource.actions,
            resource.actionPermissions,
            resource.tag,
            resource.permissions,
            resource.name,
            typedInstance.log,
          );
          createActionRouter(typedInstance, {
            ...actionConfig,
            resourceName: resource.name,
            fields: resource.fields,
            schemaOptions: resource.schemaOptions,
            // Surfaces on `req.arc.idField` inside every action handler —
            // pair with `getEntityQuery(req)` to compose the right
            // `findOne` filter when `idField !== "_id"`.
            idField: resource.idField,
            permissions: resource.permissions as Record<string, PermissionCheck> | undefined,
            routeGuards: resource.routeGuards,
            pipeline: resource.pipe,
            rateLimit: resource.rateLimit,
          });
        }

        // Register aggregation routes (v2.13) — `GET /aggregations/<name>`
        // per declared aggregation. Same prefix scope as CRUD + actions
        // so URL prefix flows through. Boot validation throws on misconfig
        // with the offending aggregation name in the message.
        if (resource.aggregations && Object.keys(resource.aggregations).length > 0) {
          const { createAggregationRouter } = await import(
            "../aggregation/createAggregationRouter.js"
          );
          const repoForAgg = (resource.controller as unknown as { repository?: unknown })
            ?.repository;
          const buildOptions = (req: unknown): AnyRecord => {
            type CtrlWithOptions = {
              tenantRepoOptions?: (req: unknown) => AnyRecord;
            };
            const ctrl = resource.controller as unknown as CtrlWithOptions | undefined;
            return ctrl?.tenantRepoOptions?.(req) ?? {};
          };
          createAggregationRouter(typedInstance, {
            tag: resource.tag,
            resourceName: resource.name,
            aggregations: resource.aggregations,
            fields: resource.fields,
            schemaOptions: resource.schemaOptions,
            permissions: resource.permissions as Record<string, PermissionCheck> | undefined,
            routeGuards: resource.routeGuards,
            repository: repoForAgg,
            buildOptions,
          });
        }

        if (resource.events && Object.keys(resource.events).length > 0) {
          typedInstance.log?.debug?.(
            `Resource '${resource.name}' defined ${Object.keys(resource.events).length} events`,
          );
        }
      },
      { prefix: resource.prefix },
    );

    // Emit resource lifecycle event (best-effort)
    if (hasEvents(fastify)) {
      try {
        await fastify.events.publish("arc.resource.registered", {
          resource: resource.name,
          prefix: resource.prefix,
          presets: resource._appliedPresets,
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* lifecycle events are best-effort */
      }
    }
  };
}
