/**
 * Resource Fastify plugin builder — everything `defineResource()` does at
 * Fastify-registration time (`ResourceDefinition.toPlugin()` delegates here):
 * shared-state writes (registry, hooks, cache rules — once per host, so
 * multi-prefix mounts don't double-register), CRUD schema synthesis, and
 * CRUD / action / aggregation router registration.
 *
 * Schema-synthesis helpers are exported so unit tests can pin their invariants.
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
import { convertRouteSchema, ensureSchemaConverter } from "../../utils/schemaConverter.js";
import { hasEvents } from "../../utils/typeGuards.js";
import { resolveActionPermission } from "../actionPermissions.js";
import { createCrudRouter } from "../createCrudRouter.js";
import { createRequestContext } from "../fastifyAdapter.js";
import type { ResourceDefinition } from "./ResourceDefinition.js";

// ============================================================================
// Pure schema-synthesis helpers (exported for unit tests)
// ============================================================================

/**
 * Build the CRUD schema map from the adapter's `OpenApiSchemas`, then layer
 * `customSchemas` on top per slot (auto-gen always runs, so customising one
 * slot never disables the others). Returns `null` when neither contributes.
 *
 * **`params` cloning is load-bearing:** `get` / `delete` / `update` each own a
 * clone, so a downstream mutation on one slot cannot leak into the others.
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
      // PATCH: optional at EVERY depth. PUT keeps `required` intact.
      // `structuredClone`, not a spread: the deep strip mutates in place and
      // `updateBody` is shared (OpenAPI docgen), so a shallow copy would corrupt it.
      const patchBody = structuredClone(updateBody as AnyRecord);
      stripRequiredDeep(patchBody);
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

  // Zod schemas auto-convert via `convertRouteSchema`.
  if (customSchemas && Object.keys(customSchemas).length > 0) {
    schemas = schemas ?? {};
    for (const [op, customSchema] of Object.entries(customSchemas)) {
      const key = op as keyof CrudSchemas;
      const converted = convertRouteSchema(customSchema as Record<string, unknown>);
      // Part-level, NOT deep: each customised part (body / params / querystring /
      // response) REPLACES the generated one wholesale; untouched parts survive.
      // Do not deep-merge — it unions `required[]`, so a custom body with a different
      // wire shape would still demand the model's required fields.
      schemas[key] = schemas[key]
        ? { ...(schemas[key] as AnyRecord), ...(converted as AnyRecord) }
        : (converted as AnyRecord);
    }
  }

  return schemas;
}

/**
 * Normalize the listQuery JSON Schema for Fastify/AJV strict mode.
 *
 * `qs` turns bracket notation (`?name[contains]=foo`, `?tags[]=a`) into nested
 * objects/arrays that AJV rejects against adapters' `type: "string"` props. The
 * QueryParser owns filter validation, so every property collapses to `{}` except
 * integer `page` / `limit`; `limit.maximum` is preserved so the parser's cap holds.
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
    // Ajv strict mode requires `type: 'object'` next to `additionalProperties`.
    type: "object",
    ...listQuerySchema,
    ...(normalizedProps ? { properties: normalizedProps } : {}),
    additionalProperties: listQuerySchema.additionalProperties ?? true,
  };
}

/**
 * Deep-merge two JSON schema branches: arrays union (deduplicated), objects
 * recurse, primitives are overwritten.
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

/**
 * Delete every `required` from a JSON-schema subtree — PATCH means optional at
 * every depth (e.g. subdocument-array `items`), whatever the generator produced.
 */
function stripRequiredDeep(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripRequiredDeep(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as AnyRecord;
  delete obj.required;
  for (const value of Object.values(obj)) stripRequiredDeep(value);
}

function safeBody(schema: AnyRecord): AnyRecord {
  // Default `additionalProperties: true`; an explicit `false` wins via spread order.
  // Only on `type: 'object'` schemas — Ajv strict mode warns otherwise.
  if (schema && typeof schema === "object" && schema.type === "object") {
    return { additionalProperties: true, ...schema };
  }
  return schema;
}

// ============================================================================
// Action router config normalization
// ============================================================================

/**
 * Normalize `ActionsMap` into the config `createActionRouter` expects.
 *
 * Permissions are resolved FAIL-CLOSED at boot via `actionPermissions.ts`: the
 * returned map carries every action's effective gate, and an action with none
 * throws. The resource-level gate uses slot `resourceActionPermissions`;
 * `globalAuth` stays reserved for direct `createActionRouter` callers.
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
  /**
   * Actions declared with `id: false` — mounted at `POST /<prefix>/action`
   * instead of `/:id/action`. Function-shorthand actions are always id-bound.
   */
  idLessActionNames: readonly string[];
} {
  const handlers: Record<
    string,
    (id: string, data: Record<string, unknown>, req: RequestWithExtras) => Promise<unknown>
  > = {};
  const permissions: Record<string, PermissionCheck> = {};
  const schemas: Record<string, Record<string, unknown>> = {};
  const idLessActionNames: string[] = [];

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
      if (def.id === false) idLessActionNames.push(name);
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
    idLessActionNames,
  };
}

// ============================================================================
// Plugin builder
// ============================================================================

/**
 * Build the FastifyPluginAsync that materialises a `ResourceDefinition` into
 * routes, hooks, registry entries, and cache invalidation rules. Can be
 * registered any number of times; shared-state writes happen once per host.
 */
export function buildResourcePlugin<TDoc>(resource: ResourceDefinition<TDoc>): FastifyPluginAsync {
  return async function resourcePlugin(fastify, opts): Promise<void> {
    // Await the lazily-imported Zod converter before ANY schema use (custom schemas,
    // routes, actions) so Zod schemas cannot slip through unconverted.
    await ensureSchemaConverter();

    // Shared state lives on the ROOT instance; key the once-per-host guard by the
    // Node HTTP server, which every encapsulation context shares.
    const sharedRoot = fastify.server as object;
    const isFirstMount = !resource._sharedStateRegisteredOn.has(sharedRoot);
    if (isFirstMount) resource._sharedStateRegisteredOn.add(sharedRoot);

    // Deferred boot assertions FIRST: they need post-boot state (e.g. a live DB
    // behind a capability descriptor) and must fail the boot, not the first write.
    if (isFirstMount && resource._deferredChecks?.length) {
      for (const check of resource._deferredChecks) check();
    }

    // Define-time diagnostics (collected before any logger existed), flushed once.
    if (isFirstMount && resource._diagnostics?.length) {
      for (const diagnostic of resource._diagnostics) {
        // `error` diagnostics already threw at define time; mapped defensively.
        const level =
          diagnostic.severity === "info"
            ? "info"
            : diagnostic.severity === "error"
              ? "error"
              : "warn";
        fastify.log?.[level]?.(diagnostic.message);
      }
    }

    const arc = (fastify as FastifyWithDecorators).arc;
    // Fatal, not logged: a resource missing from the registry still serves traffic but vanishes
    // from introspection, the permission matrix and MCP. Both causes (a duplicate name, a
    // registration after startup) are configuration errors.
    if (isFirstMount && arc?.registry && resource._registryMeta) {
      arc.registry.register(resource as ResourceDefinition<AnyRecord>, resource._registryMeta);
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

    // Declared-but-inert config (cache rules, audit, events without their plugin)
    // warns rather than being silently dropped.
    if (isFirstMount && resource.cache?.invalidateOn) {
      if (fastify.registerCacheInvalidationRule) {
        for (const [pattern, tags] of Object.entries(resource.cache.invalidateOn)) {
          fastify.registerCacheInvalidationRule({ pattern, tags });
        }
      } else {
        fastify.log?.warn?.(
          `[Arc] Resource '${resource.name}' declares \`cache.invalidateOn\` but ` +
            "`queryCachePlugin` is not registered. Cache-invalidation rules are silently " +
            "ignored. Either register the plugin (`await fastify.register(queryCachePlugin, ...)`) " +
            "or remove the `cache.invalidateOn` config to clean up the resource definition.",
        );
      }
    }

    if (isFirstMount && resource.audit) {
      const hasAuditPlugin =
        fastify.hasDecorator("audit") &&
        // A disabled `auditPlugin` installs a noop logger — counts as not running.
        typeof (fastify as { audit?: { create?: unknown } }).audit?.create === "function" &&
        (fastify as { audit?: { _noop?: boolean } }).audit?._noop !== true;
      if (!hasAuditPlugin) {
        fastify.log?.warn?.(
          `[Arc] Resource '${resource.name}' declares \`audit: ${JSON.stringify(resource.audit)}\` ` +
            "but `auditPlugin` is not registered (or is registered with a noop logger). " +
            "Audit events for this resource will NOT be recorded. Either register " +
            "`auditPlugin` (`await fastify.register(auditPlugin, { store: ... })`) or " +
            "remove the `audit` flag from the resource definition.",
        );
      }
    }

    if (isFirstMount && resource.events && Object.keys(resource.events).length > 0) {
      const eventsDecor = (fastify as { events?: { publish?: unknown } }).events;
      const hasEventPlugin = eventsDecor != null && typeof eventsDecor.publish === "function";
      if (!hasEventPlugin) {
        const eventNames = Object.keys(resource.events).join(", ");
        fastify.log?.warn?.(
          `[Arc] Resource '${resource.name}' declares events (${eventNames}) but ` +
            "`eventPlugin` is not registered. The events will silently NOT be emitted " +
            "on CRUD mutations. Either register the plugin " +
            "(`await fastify.register(eventPlugin, { transport: ... })`) or remove " +
            "the `events` declaration from the resource.",
        );
      }
    }

    // Worker-role seam (`mountRoutes: false`): everything ABOVE is shared runtime
    // state headless processes need; everything BELOW is the HTTP surface.
    // See wiki/factory.md § createWorker.
    if ((opts as { arcMountRoutes?: boolean } | undefined)?.arcMountRoutes === false) {
      return;
    }

    await fastify.register(
      async (instance) => {
        const typedInstance = instance as FastifyWithDecorators;

        let schemas: CrudSchemas | null = buildGeneratedCrudSchemas(
          resource._registryMeta?.openApiSchemas as AnyRecord | undefined,
          resource.customSchemas as AnyRecord,
        );

        // The parser's listQuery schema replaces the default querystring schema,
        // whose hardcoded `maximum: 100` would override the parser's maxLimit.
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

        createCrudRouter(typedInstance, resource.controller as CrudController<TDoc>, {
          tag: resource.tag,
          schemas: schemas ?? undefined,
          permissions: resource.permissions,
          middlewares: resource.middlewares,
          routeGuards: resource.routeGuards,
          routes: resource.routes,
          disableDefaultRoutes: resource.disableDefaultRoutes,
          // Mutable copy of a frozen array — a type-system bridge only.
          disabledRoutes: [...resource.disabledRoutes],
          resourceName: resource.name,
          schemaOptions: resource.schemaOptions,
          rateLimit: resource.rateLimit,
          updateMethod: resource.updateMethod,
          pipe: resource.pipe,
          fields: resource.fields,
          onFieldWriteDenied: resource.onFieldWriteDenied,
          idField: resource.idField,
          extensions: resource.extensions,
        });

        // Actions get the same resource-level wiring as CRUD so a mutating action
        // applies what a PATCH would.
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
            idField: resource.idField,
            permissions: resource.permissions as Record<string, PermissionCheck> | undefined,
            routeGuards: resource.routeGuards,
            pipeline: resource.pipe,
            rateLimit: resource.rateLimit,
            extensions: resource.extensions,
          });
        }

        // `GET /aggregations/<name>` per declared aggregation.
        if (resource.aggregations && Object.keys(resource.aggregations).length > 0) {
          const [
            { createAggregationRouter },
            { adapterSupportsAggregate, ArcAggregationConfigError },
          ] = await Promise.all([
            import("../aggregation/createAggregationRouter.js"),
            import("../aggregation/validate.js"),
          ]);
          // Falls back to the adapter's repository: aggregation-only resources
          // (no CRUD routes) have no controller.
          const repoForAgg =
            (resource.controller as { repository?: unknown })?.repository ?? resource.repository;
          // Boot-time: a non-`materialized` aggregation needs a repo with `aggregate()`.
          if (!adapterSupportsAggregate(repoForAgg)) {
            const undispatchable = Object.entries(resource.aggregations)
              .filter(([, cfg]) => !cfg.materialized)
              .map(([name]) => name);
            if (undispatchable.length > 0) {
              throw new ArcAggregationConfigError(
                `Resource '${resource.name}' declares aggregations [${undispatchable.join(
                  ", ",
                )}] but no repository implementing 'aggregate(req, options?)' is wired. ` +
                  `Either (a) attach an adapter whose repo ships StandardRepo.aggregate ` +
                  `(mongokit >= 3.13 / sqlitekit >= 0.3), (b) pass a custom controller ` +
                  `exposing such a repository, or (c) declare 'materialized' on each ` +
                  `aggregation so it dispatches through your own hook.`,
              );
            }
          }
          // Aggregation handlers get the raw FastifyRequest; `tenantRepoOptions` needs
          // the IRequestContext projection (scope → tenant filter), same as CRUD.
          const buildOptions = (req: unknown): AnyRecord => {
            type CtrlWithOptions = {
              tenantRepoOptions?: (req: unknown) => AnyRecord;
            };
            const ctrl = resource.controller as CtrlWithOptions | undefined;
            if (!ctrl?.tenantRepoOptions) return {};
            const ctx = createRequestContext(req as Parameters<typeof createRequestContext>[0]);
            return ctrl.tenantRepoOptions(ctx);
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
            // SECURITY: carries multiTenantPreset's tenant filter; dropping it leaks
            // aggregated rows across orgs.
            middlewares: resource.middlewares?.aggregations,
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
