/**
 * Resource Definition - Database-Agnostic Single Source of Truth
 *
 * Core abstraction that reduces boilerplate by 60-80%.
 * Works with ANY database via the adapter pattern.
 *
 * @example Mongoose
 * ```typescript
 * import { defineResource, createMongooseAdapter } from '@classytic/arc';
 * import { allowPublic, requireRoles } from '@classytic/arc/permissions';
 *
 * export default defineResource({
 *   name: 'product',
 *   adapter: createMongooseAdapter({
 *     model: ProductModel,
 *     repository: productRepository,
 *   }),
 *   presets: ['softDelete', 'slugLookup'],
 *   permissions: {
 *     list: allowPublic(),
 *     get: allowPublic(),
 *     create: requireRoles(['admin']),
 *     update: requireRoles(['admin']),
 *     delete: requireRoles(['admin']),
 *   },
 * });
 * ```
 *
 * @example Prisma (future)
 * ```typescript
 * export default defineResource({
 *   name: 'user',
 *   adapter: createPrismaAdapter({
 *     client: prisma.user,
 *     repository: userRepository,
 *   }),
 * });
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { DataAdapter } from "../adapters/interface.js";
import { CRUD_OPERATIONS } from "../constants.js";
import { applyPresets } from "../presets/index.js";
import type { RegisterOptions } from "../registry/ResourceRegistry.js";
import { buildRequestScopeProjection } from "../scope/projection.js";
import type { RequestScope } from "../scope/types.js";
import type {
  ActionDefinition,
  ActionsMap,
  AnyRecord,
  CrudController,
  CrudRouteKey,
  CrudSchemas,
  EventDefinition,
  FastifyWithDecorators,
  IController,
  MiddlewareConfig,
  OpenApiSchemas,
  PermissionCheck,
  QueryParserInterface,
  RateLimitConfig,
  RequestContext,
  RequestWithExtras,
  ResourceCacheConfig,
  ResourceConfig,
  ResourceMetadata,
  ResourcePermissions,
  RouteDefinition,
  RouteHandlerMethod,
  RouteSchemaOptions,
} from "../types/index.js";
import { convertOpenApiSchemas, convertRouteSchema } from "../utils/schemaConverter.js";
import { hasEvents } from "../utils/typeGuards.js";
import { resolveActionPermission } from "./actionPermissions.js";
import { BaseController } from "./BaseController.js";
import { createCrudRouter } from "./createCrudRouter.js";
import {
  autoInjectTenantFieldRules,
  stripSystemManagedFromBodyRequired,
} from "./schemaOptions.js";
import { assertValidConfig } from "./validateResourceConfig.js";

interface ExtendedResourceConfig<TDoc = AnyRecord> extends ResourceConfig<TDoc> {
  _appliedPresets?: string[];
  _controllerOptions?: {
    slugField?: string;
    parentField?: string;
    [key: string]: unknown;
  };
  _hooks?: Array<{
    presetName: string;
    operation: "create" | "update" | "delete" | "read" | "list";
    phase: "before" | "after";
    handler: (ctx: AnyRecord) => unknown;
    priority?: number;
  }>;
}

/**
 * Define a resource with database adapter
 *
 * This is the MAIN entry point for creating Arc resources.
 * The adapter provides both repository and schema metadata.
 */
export function defineResource<TDoc = AnyRecord>(
  config: ResourceConfig<TDoc>,
): ResourceDefinition<TDoc> {
  // Fail-fast validation
  if (!config.skipValidation) {
    assertValidConfig(config as ResourceConfig<AnyRecord>, {
      skipControllerCheck: true,
    });

    // Validate permissions are PermissionCheck functions
    if (config.permissions) {
      for (const [key, value] of Object.entries(config.permissions)) {
        if (value !== undefined && typeof value !== "function") {
          throw new Error(
            `[Arc] Resource '${config.name}': permissions.${key} must be a PermissionCheck function.\n` +
              `Use allowPublic(), requireAuth(), or requireRoles(['role']) from @classytic/arc/permissions.`,
          );
        }
      }
    }

    // Validate routes
    for (const route of config.routes ?? []) {
      if (typeof route.permissions !== "function") {
        throw new Error(
          `[Arc] Resource '${config.name}' route ${route.method} ${route.path}: ` +
            `permissions is required and must be a PermissionCheck function.`,
        );
      }
    }

    // Validate actions (v2.8)
    if (config.actions) {
      const CRUD_OPS = new Set(["create", "update", "delete", "list", "get"]);
      for (const [name, entry] of Object.entries(config.actions)) {
        if (CRUD_OPS.has(name)) {
          throw new Error(
            `[Arc] Resource '${config.name}': action '${name}' conflicts with CRUD operation.\n` +
              `Use a different name (e.g., '${name}_item', 'do_${name}').`,
          );
        }
        if (typeof entry !== "function") {
          const def = entry as ActionDefinition;
          if (typeof def.handler !== "function") {
            throw new Error(
              `[Arc] Resource '${config.name}': actions.${name}.handler must be a function.`,
            );
          }
          if (def.permissions !== undefined && typeof def.permissions !== "function") {
            throw new Error(
              `[Arc] Resource '${config.name}': actions.${name}.permissions must be a PermissionCheck function.`,
            );
          }
        }
      }
    }
  }

  // Extract repository from adapter (if provided)
  const repository = config.adapter?.repository;

  // Auto-derive idField from the repository when the user didn't set one
  // explicitly. MongoKit-style repositories declare their primary key field
  // via `repository.idField`. By picking it up here, the user only has to
  // configure idField in ONE place (the repo) and Arc threads it through:
  //   - BaseController.idField (lookup pass-through)
  //   - AJV params schema strip (UUIDs/slugs not rejected by ObjectId pattern)
  //   - ResourceDefinition.idField (introspection / OpenAPI)
  // Set it on `config` BEFORE preset resolution so presets see the same value.
  if (config.idField === undefined && repository) {
    const repoIdField = (repository as { idField?: unknown }).idField;
    if (typeof repoIdField === "string" && repoIdField !== "_id") {
      config = { ...config, idField: repoIdField };
    }
  }

  // Check if any CRUD routes will actually be created
  const crudRoutes = CRUD_OPERATIONS;
  const disabledRoutes = new Set(config.disabledRoutes ?? []);
  const hasCrudRoutes =
    !config.disableDefaultRoutes && crudRoutes.some((route) => !disabledRoutes.has(route));

  // 2. Track presets
  const originalPresets = (config.presets ?? []).map((p) =>
    typeof p === "string" ? p : (p as { name: string }).name,
  );

  // 3. Apply presets FIRST before controller instantiation
  const resolvedConfig = (
    config.presets?.length ? applyPresets(config, config.presets) : config
  ) as ExtendedResourceConfig<TDoc>;

  resolvedConfig._appliedPresets = originalPresets;

  // 3a. Auto-mark the tenant field as `systemManaged` + `preserveForElevated` (v2.10.6).
  //
  // Full rationale + edge cases live in `autoInjectTenantFieldRules`
  // (src/core/schemaOptions.ts). Delegated to a shared util so every
  // downstream reader sees the same post-inject schemaOptions —
  // `BodySanitizer` (via `resolvedConfig.schemaOptions`), the adapter's
  // `generateSchemas()` call below (same reference), the MCP tool
  // generator (via `resource.schemaOptions`, which is spread from
  // `resolvedConfig`), and the OpenAPI builder (reads the adapter's
  // `openApiSchemas` output). 2.10.6 shipped with a forwarding bug where
  // the adapter got raw `config.schemaOptions`; 2.10.7 closes that gap
  // and this centralization prevents the bug class from recurring.
  resolvedConfig.schemaOptions = autoInjectTenantFieldRules(
    resolvedConfig.schemaOptions,
    resolvedConfig.tenantField,
  );

  // 4. Create or use provided controller using the full resolved config
  let controller = resolvedConfig.controller;

  // v2.10.9 — forward the resource-level `queryParser` to user-supplied
  // controllers too. Before this, `defineResource({ controller, queryParser })`
  // threaded the parser into Fastify's listQuery schema but never into the
  // controller's own `QueryResolver`, so operator filters like `[contains]`
  // / `[like]` silently fell back to the default `ArcQueryParser` on any
  // resource that shipped a custom controller — including every resource
  // scaffolded by `arc init`. Now we inject the parser via a duck-typed
  // `setQueryParser()` call. Controllers that don't implement the method
  // (custom non-BaseController implementations) are left untouched — no
  // throw, no warn, caller is explicitly opting out of the contract.
  if (controller && resolvedConfig.queryParser) {
    const ctrl = controller as { setQueryParser?: (qp: QueryParserInterface) => void };
    if (typeof ctrl.setQueryParser === "function") {
      ctrl.setQueryParser(resolvedConfig.queryParser as QueryParserInterface);
    }
  }

  if (!controller && hasCrudRoutes && repository) {
    // Extract maxLimit from queryParser schema so BaseController's QueryResolver
    // and Fastify validation stay in sync with the parser's configured limit.
    const qp = resolvedConfig.queryParser as QueryParserInterface | undefined;
    let maxLimitFromParser: number | undefined;
    if (qp?.getQuerySchema) {
      const qpSchema = qp.getQuerySchema();
      const limitProp = qpSchema?.properties?.limit as { maximum?: number } | undefined;
      if (limitProp?.maximum) {
        maxLimitFromParser = limitProp.maximum;
      }
    }

    // Auto-create BaseController if CRUD routes exist
    controller = new BaseController<TDoc>(repository, {
      resourceName: resolvedConfig.name,
      schemaOptions: resolvedConfig.schemaOptions,
      queryParser: resolvedConfig.queryParser as QueryParserInterface | undefined,
      maxLimit: maxLimitFromParser,
      tenantField: resolvedConfig.tenantField,
      idField: resolvedConfig.idField,
      // Forward the resource-level opt-out so non-Mongo schemas can
      // declare `defaultSort: false` without constructing their own
      // BaseController. `undefined` falls back to BaseController's own
      // default (`-createdAt`) for back-compat.
      ...(resolvedConfig.defaultSort !== undefined
        ? { defaultSort: resolvedConfig.defaultSort }
        : {}),
      matchesFilter: config.adapter?.matchesFilter,
      cache: resolvedConfig.cache,
      onFieldWriteDenied: resolvedConfig.onFieldWriteDenied,
      presetFields: resolvedConfig._controllerOptions
        ? {
            slugField: resolvedConfig._controllerOptions.slugField,
            parentField: resolvedConfig._controllerOptions.parentField,
          }
        : undefined,
    }) as IController<TDoc>;
  }

  // 5. Build definition
  const resource = new ResourceDefinition({
    ...resolvedConfig,
    adapter: config.adapter,
    controller,
  } as ResolvedResourceConfig<TDoc>);

  // Validate controller methods
  if (!config.skipValidation && controller) {
    resource._validateControllerMethods();
  }

  // Collect hooks from presets — stored on resource, registered at plugin time via fastify.arc.hooks
  if (resolvedConfig._hooks?.length) {
    resource._pendingHooks.push(
      ...resolvedConfig._hooks.map((hook) => ({
        operation: hook.operation,
        phase: hook.phase,
        handler: hook.handler,
        priority: hook.priority ?? 10,
      })),
    );
  }

  // Wire up inline ResourceHooks from config.hooks
  if (config.hooks) {
    const h = config.hooks;
    type PendingHook = {
      operation: "create" | "update" | "delete";
      phase: "before" | "after";
      handler: (ctx: AnyRecord) => unknown;
      priority: number;
    };
    const inlineHooks: PendingHook[] = [];

    // `toCtx` adapts the internal `HookContext` (what BaseController
    // passes to HookSystem — `{ resource, operation, phase, data, result,
    // user, context, meta }`) into the public `ResourceHookContext` that
    // `config.hooks.{beforeCreate, afterCreate, …}` handlers sign for
    // (`{ data, user, context, scope, meta }`).
    //
    // v2.10.8 fix: previously this wrapper dropped `context` entirely, so
    // inline hook handlers had no way to reach `_scope.organizationId` /
    // `_scope.userId`. Hosts worked around it by pushing raw handlers
    // into `resource._pendingHooks`. Now `context` is forwarded and a
    // first-class `scope` projection (same shape as `IRequestContext.scope`
    // from v2.10.6) is computed from `context._scope` so inline hooks
    // don't need boilerplate.
    const toCtx = (ctx: AnyRecord) => {
      const context = ctx.context as RequestContext | undefined;
      const rawScope = (context as { _scope?: RequestScope } | undefined)?._scope;
      return {
        data: (ctx.data ?? ctx.result ?? {}) as AnyRecord,
        user: ctx.user as import("../types/index.js").UserBase | undefined,
        context: context as unknown as AnyRecord | undefined,
        scope: buildRequestScopeProjection(rawScope),
        meta: ctx.meta as AnyRecord | undefined,
      };
    };

    if (h.beforeCreate) {
      const fn = h.beforeCreate;
      inlineHooks.push({
        operation: "create",
        phase: "before",
        priority: 10,
        handler: (ctx) => fn(toCtx(ctx)),
      });
    }
    if (h.afterCreate) {
      const fn = h.afterCreate;
      inlineHooks.push({
        operation: "create",
        phase: "after",
        priority: 10,
        handler: (ctx) => fn(toCtx(ctx)),
      });
    }
    if (h.beforeUpdate) {
      const fn = h.beforeUpdate;
      inlineHooks.push({
        operation: "update",
        phase: "before",
        priority: 10,
        handler: (ctx) => fn(toCtx(ctx)),
      });
    }
    if (h.afterUpdate) {
      const fn = h.afterUpdate;
      inlineHooks.push({
        operation: "update",
        phase: "after",
        priority: 10,
        handler: (ctx) => fn(toCtx(ctx)),
      });
    }
    if (h.beforeDelete) {
      const fn = h.beforeDelete;
      inlineHooks.push({
        operation: "delete",
        phase: "before",
        priority: 10,
        handler: (ctx) => fn(toCtx(ctx)),
      });
    }
    if (h.afterDelete) {
      const fn = h.afterDelete;
      inlineHooks.push({
        operation: "delete",
        phase: "after",
        priority: 10,
        handler: (ctx) => fn(toCtx(ctx)),
      });
    }

    resource._pendingHooks.push(...inlineHooks);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // OpenAPI Schema Resolution — clear, unified priority order
  // ────────────────────────────────────────────────────────────────────────────
  //
  // Each schema slot (createBody, updateBody, response, params, listQuery) is
  // resolved independently from these sources, in priority order:
  //
  //   listQuery:
  //     1. config.openApiSchemas.listQuery   (user override — wins)
  //     2. queryParser.getQuerySchema()      (parser is source of truth)
  //     3. adapter.generateSchemas().listQuery (fallback — placeholder only)
  //
  //   createBody / updateBody / response / params:
  //     1. config.openApiSchemas.{slot}      (user override — wins)
  //     2. adapter.generateSchemas().{slot}  (auto-generated from DB schema)
  //
  // Why parser beats adapter for listQuery: the QueryParser knows the real
  // query semantics (filter operators, max limit, sort whitelist, pagination
  // mode). The adapter only knows the persistence shape — it can't infer
  // operator suffixes like `name_contains` or runtime constraints like
  // `limit.maximum`. Only the user can override the parser.
  // ────────────────────────────────────────────────────────────────────────────
  if (!config.skipRegistry) {
    try {
      // Start with adapter-generated schemas (createBody, updateBody, response, params).
      // Pass `resolvedConfig.schemaOptions` — not the raw `config` — so adapters
      // see the same `fieldRules` that `BodySanitizer` reads. Step 3a above
      // auto-injects `{ systemManaged: true, preserveForElevated: true }` on
      // the tenant field; without this forwarding, the OpenAPI / MCP body
      // schemas would still emit `organizationId` as a required input field
      // while the runtime sanitizer strips it — a half-wired auto-inject that
      // forced every multi-tenant host to restate the rule at the adapter
      // layer for their docs to match runtime behaviour.
      // **Every downstream read comes from `resolvedConfig`, never raw `config`**.
      // This is a deliberate, audited convention — 2.10.6 shipped with a
      // single `config.schemaOptions` slip that broke the auto-inject
      // forwarding to adapters, so every access here is normalized through
      // `resolvedConfig` to close the bug class.
      let openApiSchemas: OpenApiSchemas | undefined;
      if (resolvedConfig.adapter?.generateSchemas) {
        // Pass resource-level context so adapters can shape params/response etc.
        const adapterContext = {
          idField: resolvedConfig.idField,
          resourceName: resolvedConfig.name,
        };
        const generated = resolvedConfig.adapter.generateSchemas(
          resolvedConfig.schemaOptions,
          adapterContext,
        );
        if (generated) openApiSchemas = generated;
      }

      // v2.11.0 — strip every framework-injected field (any rule with
      // `systemManaged: true`) from the create/update body `required[]`
      // arrays. Covers the reported `multiTenantPreset` + engine-required
      // tenant conflict plus the broader class: `auditedPreset`'s
      // `createdBy`/`updatedBy`, any future preset that marks a field
      // systemManaged, and any host-declared rule. Full rationale +
      // call-order lives in `stripSystemManagedFromBodyRequired`
      // (src/core/schemaOptions.ts). Runs AFTER `autoInjectTenantFieldRules`
      // and AFTER preset merge, so the resolved `schemaOptions.fieldRules`
      // is the canonical source of "what will arc inject" — matching the
      // shared-util pattern that BodySanitizer reads from (defense in depth
      // between wire contract and runtime). Leaves `properties` intact so
      // elevated admins can still send the value via the body.
      openApiSchemas = stripSystemManagedFromBodyRequired(
        openApiSchemas,
        resolvedConfig.schemaOptions,
      );

      // Safety net: if idField is overridden to a non-default value, strip any
      // ObjectId pattern left on params.id by legacy adapters/plugins that
      // didn't honor the AdapterSchemaContext.idField argument. Custom ID
      // formats (UUIDs, slugs, ORD-2026-0001) must not be rejected by AJV
      // before BaseController runs the actual lookup.
      if (
        resolvedConfig.idField &&
        resolvedConfig.idField !== "_id" &&
        openApiSchemas?.params &&
        typeof openApiSchemas.params === "object"
      ) {
        const params = openApiSchemas.params as AnyRecord;
        const properties = params.properties as AnyRecord | undefined;
        const idProp = properties?.id as AnyRecord | undefined;
        if (idProp && typeof idProp === "object") {
          const pattern = idProp.pattern;
          const isObjectIdPattern =
            typeof pattern === "string" &&
            (pattern === "^[0-9a-fA-F]{24}$" ||
              pattern === "^[a-f\\d]{24}$" ||
              pattern === "^[a-fA-F0-9]{24}$" ||
              /^\^\[[a-fA-F0-9\\d]+\]\{24\}\$$/.test(pattern));
          if (isObjectIdPattern) {
            // Clone to avoid mutating the adapter's cached output
            const cleanedId: AnyRecord = { ...idProp };
            delete cleanedId.pattern;
            delete cleanedId.minLength;
            delete cleanedId.maxLength;
            if (!cleanedId.description) {
              cleanedId.description = `${resolvedConfig.idField} (custom ID field)`;
            }
            openApiSchemas = {
              ...openApiSchemas,
              params: {
                ...params,
                properties: { ...properties, id: cleanedId },
              } as AnyRecord,
            };
          }
        }
      }

      // Layer queryParser's listQuery on top — parser wins over adapter
      const queryParser = resolvedConfig.queryParser as QueryParserInterface | undefined;
      if (queryParser?.getQuerySchema) {
        const querySchema = queryParser.getQuerySchema();
        if (querySchema) {
          openApiSchemas = {
            ...openApiSchemas,
            listQuery: querySchema as unknown as AnyRecord,
          };
        }
      }

      // User-provided schemas win over everything (per-slot merge)
      if (resolvedConfig.openApiSchemas) {
        openApiSchemas = { ...openApiSchemas, ...resolvedConfig.openApiSchemas };
      }

      // Auto-convert Zod schemas to JSON Schema (no-op for plain JSON Schema)
      if (openApiSchemas) {
        openApiSchemas = convertOpenApiSchemas(openApiSchemas);
      }

      // Store registry metadata for lazy registration when toPlugin() is called
      resource._registryMeta = {
        module: resolvedConfig.module,
        openApiSchemas,
      };
    } catch {
      // Schema generation errors are non-fatal — resource still works without OpenAPI metadata
    }
  }

  return resource;
}

interface ResolvedResourceConfig<TDoc = AnyRecord> extends ResourceConfig<TDoc> {
  _appliedPresets?: string[];
  _controllerOptions?: {
    slugField?: string;
    parentField?: string;
    [key: string]: unknown;
  };
  _pendingHooks?: Array<{
    operation: "create" | "update" | "delete" | "read" | "list";
    phase: "before" | "after";
    handler: (ctx: AnyRecord) => unknown;
    priority: number;
  }>;
}

export class ResourceDefinition<TDoc = AnyRecord> {
  // Identity
  readonly name: string;
  readonly displayName: string;
  readonly tag: string;
  readonly prefix: string;

  // Adapter (database abstraction) - optional for service resources
  readonly adapter?: DataAdapter<TDoc>;

  // Controller
  readonly controller?: IController<TDoc>;

  // Schema & Validation
  readonly schemaOptions: RouteSchemaOptions;
  readonly customSchemas: CrudSchemas;

  // Security
  readonly permissions: ResourcePermissions;

  // Customization — user-declared custom routes (single source of truth).
  // Always an array; empty when the user didn't declare any. Consumers
  // (createCrudRouter, resourceToTools, OpenAPI, registry, CLI introspect)
  // read this directly. `wrapHandler` is derived from `!route.raw` at use-site.
  readonly routes: readonly RouteDefinition[];
  readonly middlewares: MiddlewareConfig;
  readonly routeGuards?: RouteHandlerMethod[];
  readonly disableDefaultRoutes: boolean;
  readonly disabledRoutes: CrudRouteKey[];

  // Actions (v2.8)
  readonly actions?: ActionsMap;
  readonly actionPermissions?: PermissionCheck;

  // Events
  readonly events: Record<string, EventDefinition>;

  // Rate limiting
  readonly rateLimit?: RateLimitConfig | false;

  // Audit (per-resource opt-in for auditPlugin perResource mode)
  readonly audit?: boolean | { operations?: ("create" | "update" | "delete")[] };

  // Update method
  readonly updateMethod?: "PUT" | "PATCH" | "both";

  // Pipeline
  readonly pipe?: import("../pipeline/types.js").PipelineConfig;

  // Field-level permissions
  readonly fields?: import("../permissions/fields.js").FieldPermissionMap;

  // Cache config
  readonly cache?: ResourceCacheConfig;

  // Prefix control
  readonly skipGlobalPrefix: boolean;

  // Multi-tenant / ID config (stored for MCP auto-controller creation)
  readonly tenantField?: string | false;
  readonly idField?: string;

  // Query parser (stored for MCP auto-derivation of filterableFields)
  readonly queryParser?: QueryParserInterface;

  // Presets tracking
  readonly _appliedPresets: string[];

  // Pending hooks from presets (registered at plugin time via fastify.arc.hooks)
  _pendingHooks: Array<{
    operation: "create" | "update" | "delete" | "read" | "list";
    phase: "before" | "after";
    handler: (ctx: AnyRecord) => unknown;
    priority: number;
  }>;

  // Registry metadata for lazy registration (populated by defineResource, consumed by toPlugin)
  _registryMeta?: RegisterOptions;

  constructor(config: ResolvedResourceConfig<TDoc>) {
    // Identity
    this.name = config.name;
    this.displayName = config.displayName ?? `${capitalize(config.name)}s`;
    this.tag = config.tag ?? this.displayName;
    this.prefix = config.prefix ?? `/${config.name}s`;
    this.skipGlobalPrefix = config.skipGlobalPrefix ?? false;

    // Adapter
    this.adapter = config.adapter;

    // Controller
    this.controller = config.controller as IController<TDoc> | undefined;

    // Schema & Validation
    this.schemaOptions = config.schemaOptions ?? {};
    this.customSchemas = config.customSchemas ?? {};

    // Security
    this.permissions = (config.permissions ?? {}) as ResourcePermissions;

    // `config.routes` is the single source — user routes + preset routes
    // are merged here by `applyPresets → mergePreset`. Always stored as an
    // array (possibly empty); no separate normalised copy.
    this.routes = (config.routes ?? []) as readonly RouteDefinition[];
    this.middlewares = config.middlewares ?? {};
    this.routeGuards = config.routeGuards;
    this.disableDefaultRoutes = config.disableDefaultRoutes ?? false;
    this.disabledRoutes = config.disabledRoutes ?? [];

    // Actions (v2.8)
    this.actions = config.actions;
    this.actionPermissions = config.actionPermissions;

    // Events
    this.events = config.events ?? {};

    // Rate limiting
    this.rateLimit = config.rateLimit;

    // Audit
    this.audit = config.audit;

    // Update method
    this.updateMethod = config.updateMethod;

    // Pipeline
    this.pipe = config.pipe;

    // Field-level permissions
    this.fields = config.fields;

    // Cache config
    this.cache = config.cache;

    // Multi-tenant / ID config
    this.tenantField = config.tenantField;
    this.idField = config.idField;

    // Query parser (stored for MCP auto-derivation)
    this.queryParser = config.queryParser as QueryParserInterface | undefined;

    // Presets tracking
    this._appliedPresets = config._appliedPresets ?? [];

    // Pending hooks from presets
    this._pendingHooks = config._pendingHooks ?? [];
  }

  /** Get repository from adapter (if available) */
  get repository() {
    return this.adapter?.repository;
  }

  _validateControllerMethods(): void {
    const errors: string[] = [];

    // Check if any CRUD routes will actually be created
    const crudRoutes = CRUD_OPERATIONS;
    const disabledRoutes = new Set(this.disabledRoutes ?? []);
    const enabledCrudRoutes = crudRoutes.filter((route) => !disabledRoutes.has(route));
    const hasCrudRoutes = !this.disableDefaultRoutes && enabledCrudRoutes.length > 0;

    if (hasCrudRoutes) {
      if (!this.controller) {
        errors.push("Controller is required when CRUD routes are enabled");
      } else {
        const ctrl = this.controller as unknown as AnyRecord;
        // Only validate methods for enabled routes
        for (const method of enabledCrudRoutes) {
          if (typeof ctrl[method] !== "function") {
            errors.push(`CRUD method '${method}' not found on controller`);
          }
        }
      }
    }

    for (const route of this.routes) {
      if (typeof route.handler === "string") {
        if (!this.controller) {
          errors.push(
            `Route ${route.method} ${route.path}: string handler '${route.handler}' requires a controller`,
          );
        } else {
          const ctrl = this.controller as unknown as Record<string, unknown>;
          if (typeof ctrl[route.handler] !== "function") {
            errors.push(
              `Route ${route.method} ${route.path}: handler '${route.handler}' not found`,
            );
          }
        }
      }
    }

    if (errors.length > 0) {
      const errorMsg = [
        `Resource '${this.name}' validation failed:`,
        ...errors.map((e) => `  - ${e}`),
        "",
        "Ensure controller implements IController<TDoc> interface.",
        "For preset routes (softDelete, tree), add corresponding methods to controller.",
      ].join("\n");

      throw new Error(errorMsg);
    }
  }

  toPlugin(): FastifyPluginAsync {
    const self = this;

    return async function resourcePlugin(fastify, _opts): Promise<void> {
      // Register with instance-scoped registry (if arc core plugin is loaded)
      const arc = (fastify as FastifyWithDecorators).arc;
      if (arc?.registry && self._registryMeta) {
        try {
          arc.registry.register(
            self as unknown as ResourceDefinition<AnyRecord>,
            self._registryMeta,
          );
        } catch (err) {
          fastify.log?.warn?.(
            `Failed to register resource '${self.name}' in registry: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Register pending hooks from presets with instance-scoped hook system
      if (self._pendingHooks.length > 0) {
        const arc = (fastify as FastifyWithDecorators).arc;
        if (arc?.hooks) {
          for (const hook of self._pendingHooks) {
            arc.hooks.register({
              resource: self.name,
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
      }

      // Register cross-resource cache invalidation rules
      const registerRule = (fastify as unknown as Record<string, unknown>)
        .registerCacheInvalidationRule;
      if (self.cache?.invalidateOn && typeof registerRule === "function") {
        for (const [pattern, tags] of Object.entries(self.cache.invalidateOn)) {
          (registerRule as (rule: { pattern: string; tags: string[] }) => void)({ pattern, tags });
        }
      }

      await fastify.register(
        async (instance) => {
          const typedInstance = instance as FastifyWithDecorators;

          // Schema generation is handled at define-time (see defineResource, lines ~222-230).
          // No competing runtime generation here.
          let schemas: CrudSchemas | null = null;

          // Auto-generate CrudSchemas from adapter's OpenApiSchemas when customSchemas
          // isn't provided. Maps createBody → create.body, updateBody → update.body,
          // params → get/update/delete.params, response → all ops.
          //
          // Body schemas default to additionalProperties:true so the built-in fallback
          // extractor doesn't reject unknown fields. Explicit generators (MongoKit) can
          // override this by setting additionalProperties in their output.
          const openApi = self._registryMeta?.openApiSchemas;
          if (openApi && (!self.customSchemas || Object.keys(self.customSchemas).length === 0)) {
            const generated: Record<string, AnyRecord> = {};
            const { createBody, updateBody, params } = openApi as AnyRecord;

            // Ensure body schemas allow additional properties by default
            // (prevents the built-in Mongoose extractor from rejecting unknown fields)
            const safeBody = (schema: AnyRecord): AnyRecord => {
              if (schema && typeof schema === "object" && schema.type === "object") {
                return { additionalProperties: true, ...schema };
              }
              return schema;
            };

            if (createBody) {
              generated.create = { body: safeBody(createBody as AnyRecord) };
            }
            if (updateBody) {
              // PATCH semantics: strip `required` so all fields are optional.
              // PUT gets the original with required fields intact.
              const patchBody = { ...(updateBody as AnyRecord) };
              delete patchBody.required;
              generated.update = { body: safeBody(patchBody) };
              if (params) generated.update.params = params;
            }
            if (params) {
              generated.get = { params };
              generated.delete = { params };
              if (!generated.update) generated.update = { params };
              else if (!generated.update.params) generated.update.params = params;
            }

            if (Object.keys(generated).length > 0) {
              schemas = generated as CrudSchemas;
            }
          }

          // Merge custom schemas (auto-convert Zod schemas within)
          // Uses convertRouteSchema which properly handles nested response schemas
          // e.g. { body: z.object(...), response: { 201: z.object(...) } }
          // customSchemas override auto-generated schemas when both exist.
          if (self.customSchemas && Object.keys(self.customSchemas).length > 0) {
            schemas = schemas ?? {};
            for (const [op, customSchema] of Object.entries(self.customSchemas)) {
              const key = op as keyof CrudSchemas;
              const converted = convertRouteSchema(customSchema as Record<string, unknown>);
              schemas[key] = schemas[key]
                ? deepMergeSchemas(schemas[key] as AnyRecord, converted as AnyRecord)
                : (converted as AnyRecord);
            }
          }

          // Apply queryParser's listQuery schema as the Fastify querystring
          // validation schema for the list route. Without this, the hardcoded
          // default (maximum: 100) overrides the parser's configured maxLimit.
          //
          // Normalize the schema for Fastify/AJV compatibility:
          // 1. Default additionalProperties to true (matching Arc's own getListQueryParams)
          // 2. Remove type constraints from params that qs may parse as objects
          //    (e.g., ?populate[author][select]=name → { populate: { author: { select: "name" } } })
          //    External schemas often declare these as type:"string" for OpenAPI docs,
          //    but qs bracket notation produces objects that AJV would then reject.
          const listQuerySchema = self._registryMeta?.openApiSchemas?.listQuery;
          if (listQuerySchema) {
            // Strip type constraints from ALL querystring properties.
            //
            // Why: The `qs` parser transforms bracket notation into nested objects/arrays:
            //   ?name[contains]=foo  → { name: { contains: "foo" } }  (object, not string)
            //   ?tags[]=a&tags[]=b   → { tags: ["a", "b"] }           (array, not string)
            //   ?populate[author][select]=name → deep nested object
            //
            // AJV rejects these because the schema declares them as type:"string".
            // The QueryParser handles validation and type coercion — AJV should only
            // enforce structure (additionalProperties), not types on querystrings.
            //
            // Normalization strategy for list query:
            //
            // The `qs` parser transforms bracket notation into nested values at runtime:
            //   ?name[contains]=foo  → { name: { contains: "foo" } }
            //   ?tags[]=a&tags[]=b   → { tags: ["a", "b"] }
            //
            // Any schema constraint on filter fields will fight the parser output AND
            // confuse AJV strict mode (which rejects `additionalProperties` or `minimum`
            // keywords without a matching top-level `type`, including inside oneOf/anyOf/allOf
            // branches).
            //
            // Our approach: replace each property with a minimal AJV-strict-mode-clean
            // shape. Numeric pagination keys get `type: "integer"` so AJV doesn't warn
            // about `minimum`/`maximum` without type. Everything else becomes `{}` —
            // qs bracket notation produces objects/arrays that the QueryParser handles
            // at runtime, so Arc just needs AJV to let requests through.
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
            const props = (listQuerySchema as AnyRecord).properties as AnyRecord | undefined;
            const normalizedProps = props ? { ...props } : undefined;
            if (normalizedProps) {
              // Pull max limit from the original schema so the parser's configured
              // maxLimit is preserved, even though we replace the rest of the shape.
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
            const normalizedSchema = {
              ...listQuerySchema,
              ...(normalizedProps ? { properties: normalizedProps } : {}),
              additionalProperties: (listQuerySchema as AnyRecord).additionalProperties ?? true,
            };
            schemas = schemas ?? {};
            schemas.list = schemas.list
              ? deepMergeSchemas(
                  { querystring: normalizedSchema } as AnyRecord,
                  schemas.list as AnyRecord,
                )
              : ({ querystring: normalizedSchema } as AnyRecord);
          }

          // Pass routes as-is to createCrudRouter.
          // String handler resolution + `wrapHandler` derivation (from `!route.raw`)
          // happen inside createCrudRouter.
          createCrudRouter(typedInstance, self.controller as unknown as CrudController<TDoc>, {
            tag: self.tag,
            schemas: schemas ?? undefined,
            permissions: self.permissions,
            middlewares: self.middlewares,
            routeGuards: self.routeGuards,
            routes: self.routes,
            disableDefaultRoutes: self.disableDefaultRoutes,
            disabledRoutes: self.disabledRoutes,
            resourceName: self.name,
            schemaOptions: self.schemaOptions,
            rateLimit: self.rateLimit,
            updateMethod: self.updateMethod,
            pipe: self.pipe,
            fields: self.fields,
          });

          // Register first-class actions (v2.8) — after CRUD routes, inside prefix scope
          if (self.actions && Object.keys(self.actions).length > 0) {
            const { createActionRouter } = await import("./createActionRouter.js");
            const actionConfig = normalizeActionsToRouterConfig(
              self.actions,
              self.actionPermissions,
              self.tag,
              self.permissions,
              self.name,
              typedInstance.log,
            );
            createActionRouter(instance as unknown as FastifyInstance, actionConfig);
          }

          if (self.events && Object.keys(self.events).length > 0) {
            typedInstance.log?.debug?.(
              `Resource '${self.name}' defined ${Object.keys(self.events).length} events`,
            );
          }
        },
        { prefix: self.prefix },
      );

      // Emit resource lifecycle event (best-effort)
      if (hasEvents(fastify)) {
        try {
          await fastify.events.publish("arc.resource.registered", {
            resource: self.name,
            prefix: self.prefix,
            presets: self._appliedPresets,
            timestamp: new Date().toISOString(),
          });
        } catch {
          /* lifecycle events are best-effort */
        }
      }
    };
  }

  /**
   * Get event definitions for registry
   */
  getEvents(): Array<{
    name: string;
    module: string;
    schema?: AnyRecord;
    description?: string;
  }> {
    return Object.entries(this.events).map(([action, meta]) => ({
      name: `${this.name}:${action}`,
      module: this.name,
      schema: meta.schema,
      description: meta.description,
    }));
  }

  /**
   * Get resource metadata
   */
  getMetadata(): ResourceMetadata {
    return {
      name: this.name,
      displayName: this.displayName,
      tag: this.tag,
      prefix: this.prefix,
      presets: this._appliedPresets,
      permissions: this.permissions,
      customRoutes: (this.routes ?? []).map((r) => ({
        method: r.method,
        path: r.path,
        handler:
          typeof r.handler === "string" ? r.handler : (r.handler as Function).name || "anonymous",
        operation: r.operation,
        summary: r.summary,
        description: r.description,
        permissions: r.permissions,
        raw: r.raw,
        schema: r.schema as Record<string, unknown>,
      })),
      routes: [], // Populated at runtime during registration
      events: Object.keys(this.events),
    };
  }
}

function deepMergeSchemas(base: AnyRecord, override: AnyRecord): AnyRecord {
  if (!override) return base;
  if (!base) return override;

  const result: AnyRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value) && Array.isArray(result[key])) {
      // Merge arrays with deduplication (e.g., required, enum)
      result[key] = [...new Set([...(result[key] as unknown[]), ...value])];
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMergeSchemas(result[key] as AnyRecord, value as AnyRecord);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function capitalize(str: string): string {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================================================
// v2.8 — model auto-detection
// ============================================================================

// ============================================================================
// v2.8 — actions → ActionRouterConfig conversion
// ============================================================================

/**
 * Normalize `ActionsMap` into the `ActionRouterConfig` shape that
 * `createActionRouter` expects.
 *
 * **Permission fallback chain (fail-closed, v2.10.5):**
 * Actions mutate state, so "no permission declared" historically meant
 * "authenticated users can call it" — a silent authz hole for apps using
 * the function shorthand `actions: { send: async (id, data, req) => ... }`.
 *
 * The chain is now:
 *   1. `ActionDefinition.permissions` — explicit per-action check.
 *   2. Resource-level `actionPermissions` — explicit global-for-actions.
 *   3. Resource-level `permissions.update` — sensible default (actions mutate).
 *   4. Boot-time error — forces the author to pick an explicit gate.
 *
 * When step 3 fires, we log a warning (not a throw) so upgrading apps
 * aren't bricked by the behavior change, but the gap is visible. Apps
 * that genuinely want public actions must declare `allowPublic()`
 * explicitly — auth-by-accident is no longer a supported state.
 */
function normalizeActionsToRouterConfig(
  actions: ActionsMap,
  globalAuth: PermissionCheck | undefined,
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
  globalAuth?: PermissionCheck;
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
      if (def.permissions) permissions[name] = def.permissions;
      if (def.schema) schemas[name] = def.schema as Record<string, unknown>;
    }

    // Resolve the effective gate via the shared resolver so HTTP, MCP, and
    // OpenAPI apply the SAME fallback chain. HTTP also needs to emit a warn
    // when the chain hits `permissions.update`, and fail-loud at boot when
    // nothing resolves — neither of those belong in the resolver itself.
    const effective = resolveActionPermission({
      action: entry,
      resourcePermissions,
      resourceActionPermissions: undefined,
      globalAuth,
    });

    const hitUpdateFallback =
      !explicit && !globalAuth && effective && effective === resourcePermissions?.update;

    if (hitUpdateFallback) {
      permissions[name] = effective as PermissionCheck;
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

    // Nothing to fall back to → fail loud at boot. Authenticated-only
    // actions are never silently allowed; callers must opt in with
    // `allowPublic()` or `requireAuth()` if that's actually desired.
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
  }

  return {
    tag,
    actions: handlers,
    actionPermissions: permissions,
    actionSchemas: schemas,
    globalAuth,
  };
}
