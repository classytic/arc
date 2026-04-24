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

import type { FastifyPluginAsync } from "fastify";
import type { DataAdapter } from "../adapters/interface.js";
import { CRUD_OPERATIONS } from "../constants.js";
import { arcLog } from "../logger/index.js";
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
import { autoInjectTenantFieldRules, stripSystemManagedFromBodyRequired } from "./schemaOptions.js";
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
 * Define a resource with database adapter.
 *
 * This is the MAIN entry point for creating Arc resources — the adapter
 * provides both repository and schema metadata.
 *
 * Staged into seven named phases so future refactors touch one phase at a
 * time instead of threading changes through a 450-line function:
 *
 *   1. validate                  — fail-fast structural checks
 *   2. resolveIdField            — auto-derive `idField` from repository
 *   3. applyPresetsAndAutoInject — clone + apply presets + tenant-field rules
 *   4. resolveController         — reuse user controller or auto-create BaseController
 *   5. buildResource             — construct ResourceDefinition + validate methods
 *   6. wireHooks                 — push preset + inline `config.hooks` onto _pendingHooks
 *   7. resolveOpenApiSchemas     — adapter schemas → parser listQuery → user override
 *
 * Each phase has a single responsibility; `resolvedConfig` is the canonical
 * post-preset, post-auto-inject config that every later phase reads. Raw
 * `config` is only consulted for things presets don't touch (adapter,
 * skipRegistry, skipValidation, hooks — which are wired separately from
 * preset hooks).
 */
// v2.11 — `TDoc` is UNCONSTRAINED at this layer. The previous
// `TDoc extends AnyRecord` bound leaked out of BaseController's
// mixin-composition requirement into every host's adapter boundary:
// Mongoose's `HydratedDocument<T>`, Prisma's generated row types, and
// any domain interface without an explicit index signature all failed
// to satisfy `Record<string, unknown>` even though at runtime they ARE
// string-keyed objects. Hosts were forced to cast at every adapter
// (`as RepositoryLike<Record<string, unknown>>`) — a type escape with
// no runtime purpose, since arc's pipeline only reads known envelope
// fields.
//
// The cast moved inside `resolveOrAutoCreateController` where
// `BaseController<TDoc extends AnyRecord>` actually requires it. One
// internal boundary cast replaces N host-side casts.
export function defineResource<TDoc = AnyRecord>(
  config: ResourceConfig<TDoc>,
): ResourceDefinition<TDoc> {
  // Phase 1 — validate
  if (!config.skipValidation) {
    validateDefineResourceConfig(config);
  }

  // Phase 2 — resolve idField from repository before presets see it
  const repository = config.adapter?.repository;
  const configWithId = resolveIdField(config, repository);

  // Phase 3 — apply presets + auto-inject tenant-field system-managed rules
  const resolvedConfig = applyPresetsAndAutoInject<TDoc>(configWithId);

  // Compute once: does this resource register any default CRUD routes?
  const hasCrudRoutes = computeHasCrudRoutes(resolvedConfig);

  // Phase 4 — reuse user controller or auto-create BaseController.
  //
  // The cast here is the one internal boundary where `TDoc` must widen to
  // satisfy `BaseController<TDoc extends AnyRecord>`. At runtime every
  // document is a string-keyed object, so the widening is safe; at the
  // type layer it lets hosts pass narrow domain types (Mongoose
  // `HydratedDocument<T>`, Prisma row types) without polluting their
  // interfaces with an index signature. Kept local to arc so hosts
  // never see it — the whole point of relaxing `defineResource`'s
  // `TDoc` bound.
  const narrowedConfig = resolvedConfig as unknown as ExtendedResourceConfig<TDoc & AnyRecord>;
  const narrowedAdapter = configWithId.adapter as
    | import("../adapters/interface.js").DataAdapter<TDoc & AnyRecord>
    | undefined;
  const controller = resolveOrAutoCreateController(
    narrowedConfig,
    narrowedAdapter,
    repository,
    hasCrudRoutes,
  );

  // Phase 5 — build the ResourceDefinition and validate controller methods
  const resource = new ResourceDefinition({
    ...resolvedConfig,
    adapter: configWithId.adapter,
    controller,
  } as unknown as ResolvedResourceConfig<TDoc>);

  if (!config.skipValidation && controller) {
    resource._validateControllerMethods();
  }

  // Phase 6 — wire preset hooks + inline config.hooks onto the resource
  wireHooks(
    resource as unknown as ResourceDefinition<TDoc & AnyRecord>,
    narrowedConfig,
    configWithId.hooks,
  );

  // Phase 7 — resolve OpenAPI schemas (adapter → systemManaged strip → idField
  //           pattern clean → queryParser listQuery → user override). Non-fatal:
  //           warns on failure so the resource still boots; `_registryMeta`
  //           stays undefined on failure so registry consumers see a clean
  //           "no metadata" signal instead of a half-built object.
  if (!config.skipRegistry) {
    const registryMeta = resolveOpenApiSchemas(narrowedConfig);
    if (registryMeta) resource._registryMeta = registryMeta;
  }

  return resource;
}

// ============================================================================
// Phase 1 — validate
// ============================================================================

function validateDefineResourceConfig<TDoc>(config: ResourceConfig<TDoc>): void {
  assertValidConfig(config as ResourceConfig<AnyRecord>, {
    skipControllerCheck: true,
  });

  // Permissions must be PermissionCheck functions
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

  // Custom routes must declare permissions explicitly (fail-closed)
  for (const route of config.routes ?? []) {
    if (typeof route.permissions !== "function") {
      throw new Error(
        `[Arc] Resource '${config.name}' route ${route.method} ${route.path}: ` +
          `permissions is required and must be a PermissionCheck function.`,
      );
    }
  }

  // Actions (v2.8) — name must not collide with CRUD ops; handler + permissions
  // must have the right shapes.
  if (config.actions) {
    const CRUD_OPS = new Set<string>(["create", "update", "delete", "list", "get"]);
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

// ============================================================================
// Phase 2 — resolveIdField
// ============================================================================

/**
 * Auto-derive `idField` from the repository when the user didn't set one
 * explicitly. MongoKit-style repositories declare their primary key field
 * via `repository.idField`. By picking it up here (BEFORE preset resolution),
 * the user configures idField in ONE place (the repo) and arc threads it
 * through `BaseController`, AJV params schema, `ResourceDefinition.idField`,
 * and preset field wiring consistently.
 *
 * Returns a fresh config — never mutates the caller's reference.
 */
function resolveIdField<TDoc>(
  config: ResourceConfig<TDoc>,
  repository: unknown,
): ResourceConfig<TDoc> {
  if (config.idField !== undefined || !repository) return config;
  const repoIdField = (repository as { idField?: unknown }).idField;
  if (typeof repoIdField === "string" && repoIdField !== "_id") {
    return { ...config, idField: repoIdField };
  }
  return config;
}

// ============================================================================
// Phase 3 — applyPresetsAndAutoInject
// ============================================================================

/**
 * Produce the canonical `resolvedConfig` — a fresh clone of the caller's
 * config with presets applied and tenant-field schema rules auto-injected.
 *
 * v2.11.0: always returns a fresh object so downstream mutations
 * (`_appliedPresets`, `schemaOptions` auto-inject, `_controllerOptions`,
 * `_pendingHooks`) never leak onto the caller's config. Before 2.11 the
 * no-preset branch returned the raw caller reference, which mutated
 * resource-config fragments hosts were reusing.
 *
 * Full rationale for tenant-field auto-inject lives in
 * `autoInjectTenantFieldRules` (src/core/schemaOptions.ts). Centralised here
 * so every downstream reader (`BodySanitizer`, adapter `generateSchemas()`,
 * MCP tool generator, OpenAPI builder) sees the same post-inject shape.
 */
function applyPresetsAndAutoInject<TDoc>(
  config: ResourceConfig<TDoc>,
): ExtendedResourceConfig<TDoc> {
  const originalPresets = (config.presets ?? []).map((p) =>
    typeof p === "string" ? p : (p as { name: string }).name,
  );

  const resolvedConfig = (
    config.presets?.length ? applyPresets(config, config.presets) : { ...config }
  ) as ExtendedResourceConfig<TDoc>;

  resolvedConfig._appliedPresets = originalPresets;
  resolvedConfig.schemaOptions = autoInjectTenantFieldRules(
    resolvedConfig.schemaOptions,
    resolvedConfig.tenantField,
  );

  return resolvedConfig;
}

function computeHasCrudRoutes<TDoc>(config: ResourceConfig<TDoc>): boolean {
  const disabled = new Set(config.disabledRoutes ?? []);
  return !config.disableDefaultRoutes && CRUD_OPERATIONS.some((op) => !disabled.has(op));
}

// ============================================================================
// Phase 4 — resolveOrAutoCreateController
// ============================================================================

/**
 * Pick the controller for the resource:
 *   - user-supplied controller → forward `queryParser` to it (duck-typed)
 *   - no controller + CRUD routes + repository → auto-create BaseController
 *   - otherwise → undefined (custom-routes-only resource)
 *
 * Duck-typed `setQueryParser()` forwarding (v2.10.9) ensures operator filters
 * like `[contains]` / `[like]` work in custom controllers too. Controllers
 * that don't implement the method get a boot-time warn (v2.11) so authors
 * of hand-rolled controllers see the dropped parser instead of silently
 * debugging stale filter semantics. `BaseController` subclasses pick it up
 * automatically.
 */
function resolveOrAutoCreateController<TDoc extends AnyRecord>(
  resolvedConfig: ExtendedResourceConfig<TDoc>,
  adapter: ResourceConfig<TDoc>["adapter"],
  repository: unknown,
  hasCrudRoutes: boolean,
): IController<TDoc> | undefined {
  let controller = resolvedConfig.controller;

  if (controller && resolvedConfig.queryParser) {
    const ctrl = controller as { setQueryParser?: (qp: QueryParserInterface) => void };
    if (typeof ctrl.setQueryParser === "function") {
      ctrl.setQueryParser(resolvedConfig.queryParser as QueryParserInterface);
    } else {
      // v2.11 — warn when the parser can't be threaded. Hand-rolled
      // controllers without `setQueryParser` silently fall back to their
      // internal default, which produces hard-to-diagnose drift between
      // the OpenAPI schema (which reflects `resolvedConfig.queryParser`)
      // and the actual filter semantics the controller applies. One warn
      // at boot turns a 90-minute debug into a visible log line. Honors
      // `ARC_SUPPRESS_WARNINGS=1`.
      arcLog("defineResource").warn(
        `Resource "${resolvedConfig.name}" declares a custom \`queryParser\` but its controller ` +
          "does not expose `setQueryParser(qp)`. The parser will NOT be threaded into the " +
          "controller's query resolution — operator filters (`[contains]`, `[like]`, etc.) may " +
          "fall back to the controller's internal default. Extend `BaseController` / " +
          "`BaseCrudController` (both implement `setQueryParser`) OR add the method to your " +
          "custom controller to honor the resource-level parser.",
      );
    }
  }

  if (controller || !hasCrudRoutes || !repository) {
    return controller as unknown as IController<TDoc> | undefined;
  }

  // Auto-create BaseController. Extract maxLimit from queryParser schema so
  // BaseController's QueryResolver and Fastify validation stay in sync with
  // the parser's configured limit.
  const qp = resolvedConfig.queryParser as QueryParserInterface | undefined;
  let maxLimitFromParser: number | undefined;
  if (qp?.getQuerySchema) {
    const qpSchema = qp.getQuerySchema();
    const limitProp = qpSchema?.properties?.limit as { maximum?: number } | undefined;
    if (limitProp?.maximum) {
      maxLimitFromParser = limitProp.maximum;
    }
  }

  controller = new BaseController<TDoc>(repository, {
    resourceName: resolvedConfig.name,
    schemaOptions: resolvedConfig.schemaOptions,
    queryParser: resolvedConfig.queryParser as QueryParserInterface | undefined,
    maxLimit: maxLimitFromParser,
    tenantField: resolvedConfig.tenantField,
    idField: resolvedConfig.idField,
    ...(resolvedConfig.defaultSort !== undefined
      ? { defaultSort: resolvedConfig.defaultSort }
      : {}),
    matchesFilter: adapter?.matchesFilter,
    cache: resolvedConfig.cache,
    onFieldWriteDenied: resolvedConfig.onFieldWriteDenied,
    presetFields: resolvedConfig._controllerOptions
      ? {
          slugField: resolvedConfig._controllerOptions.slugField,
          parentField: resolvedConfig._controllerOptions.parentField,
        }
      : undefined,
  }) as IController<TDoc>;

  return controller as unknown as IController<TDoc>;
}

// ============================================================================
// Phase 6 — wireHooks (preset hooks + inline config.hooks)
// ============================================================================

/**
 * Push preset-collected hooks and inline `config.hooks` onto the resource's
 * `_pendingHooks`. The inline `config.hooks` handlers get a
 * `ResourceHookContext` projection (v2.10.8) so they can reach `scope` /
 * `context` without reaching into internal fields.
 */
function wireHooks<TDoc extends AnyRecord>(
  resource: ResourceDefinition<TDoc>,
  resolvedConfig: ExtendedResourceConfig<TDoc>,
  inlineHooksConfig: ResourceConfig<TDoc>["hooks"],
): void {
  // Preset hooks — already normalised by `applyPresets`
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

  // Inline `config.hooks.{before,after}{Create,Update,Delete}` — 6 nearly-
  // identical blocks collapsed into a table + loop.
  if (!inlineHooksConfig) return;

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

  type InlineHookSpec = {
    key: keyof NonNullable<ResourceConfig<TDoc>["hooks"]>;
    operation: "create" | "update" | "delete";
    phase: "before" | "after";
  };

  const INLINE_HOOK_SPECS: readonly InlineHookSpec[] = [
    { key: "beforeCreate", operation: "create", phase: "before" },
    { key: "afterCreate", operation: "create", phase: "after" },
    { key: "beforeUpdate", operation: "update", phase: "before" },
    { key: "afterUpdate", operation: "update", phase: "after" },
    { key: "beforeDelete", operation: "delete", phase: "before" },
    { key: "afterDelete", operation: "delete", phase: "after" },
  ];

  const h = inlineHooksConfig as Record<string, (ctx: unknown) => unknown>;
  for (const spec of INLINE_HOOK_SPECS) {
    const fn = h[spec.key as string];
    if (typeof fn !== "function") continue;
    resource._pendingHooks.push({
      operation: spec.operation,
      phase: spec.phase,
      priority: 10,
      handler: (ctx) => fn(toCtx(ctx)),
    });
  }
}

// ============================================================================
// Phase 7 — resolveOpenApiSchemas
// ============================================================================

/**
 * Resolve OpenAPI schemas for a resource with a unified priority order:
 *
 *   listQuery:
 *     1. config.openApiSchemas.listQuery    (user override — wins)
 *     2. queryParser.getQuerySchema()       (parser is source of truth)
 *     3. adapter.generateSchemas().listQuery (fallback placeholder)
 *
 *   createBody / updateBody / response / params:
 *     1. config.openApiSchemas.{slot}       (user override — wins)
 *     2. adapter.generateSchemas().{slot}   (auto-generated from DB schema)
 *
 * Why parser beats adapter for listQuery: the QueryParser knows the real
 * query semantics (filter operators, max limit, sort whitelist, pagination).
 * The adapter only knows persistence — it can't infer `name_contains` or
 * `limit.maximum`.
 *
 * **Every downstream read comes from `resolvedConfig`, never raw `config`.**
 * This is an audited convention — 2.10.6 shipped with a single
 * `config.schemaOptions` slip that broke auto-inject forwarding, so every
 * access is normalised through `resolvedConfig` to close the bug class.
 *
 * Non-fatal: if any phase throws, returns registry metadata anyway (with
 * `openApiSchemas: undefined`) and warns. The resource still boots — docs
 * and MCP tool schemas degrade visibly instead of silently drifting.
 */
function resolveOpenApiSchemas<TDoc extends AnyRecord>(
  resolvedConfig: ExtendedResourceConfig<TDoc>,
): RegisterOptions | undefined {
  try {
    let openApiSchemas = generateAdapterSchemas(resolvedConfig);
    openApiSchemas = stripSystemManagedFromBodyRequired(
      openApiSchemas,
      resolvedConfig.schemaOptions,
    );
    openApiSchemas = cleanLegacyObjectIdParams(openApiSchemas, resolvedConfig.idField);
    openApiSchemas = layerQueryParserListQuery(openApiSchemas, resolvedConfig.queryParser);
    openApiSchemas = mergeUserOpenApiOverrides(openApiSchemas, resolvedConfig.openApiSchemas);
    if (openApiSchemas) openApiSchemas = convertOpenApiSchemas(openApiSchemas);
    return { module: resolvedConfig.module, openApiSchemas };
  } catch (err) {
    // v2.11.0: schema-generation errors are non-fatal but not silent — the
    // resource boots and serves traffic, docs/introspection will be missing.
    // Honors `ARC_SUPPRESS_WARNINGS=1`.
    arcLog("defineResource").warn(
      `OpenAPI/MCP schema generation failed for resource "${resolvedConfig.name}": ${
        err instanceof Error ? err.message : String(err)
      }. Resource will boot without registry metadata — OpenAPI docs and MCP tool schemas will be missing.`,
    );
    return undefined;
  }
}

function generateAdapterSchemas<TDoc extends AnyRecord>(
  resolvedConfig: ExtendedResourceConfig<TDoc>,
): OpenApiSchemas | undefined {
  if (!resolvedConfig.adapter?.generateSchemas) return undefined;
  const adapterContext = {
    idField: resolvedConfig.idField,
    resourceName: resolvedConfig.name,
  };
  return resolvedConfig.adapter.generateSchemas(resolvedConfig.schemaOptions, adapterContext) as
    | OpenApiSchemas
    | undefined;
}

/**
 * Safety net: when `idField` is overridden to a non-default value (UUIDs,
 * slugs, ORD-2026-0001), strip any ObjectId pattern left on `params.id` by
 * legacy adapters or plugins that didn't honor `AdapterSchemaContext.idField`.
 * Custom IDs must not be rejected by AJV before BaseController runs the
 * actual lookup.
 */
function cleanLegacyObjectIdParams(
  openApiSchemas: OpenApiSchemas | undefined,
  idField: string | undefined,
): OpenApiSchemas | undefined {
  if (!openApiSchemas || !idField || idField === "_id") return openApiSchemas;
  const params = openApiSchemas.params as AnyRecord | undefined;
  if (!params || typeof params !== "object") return openApiSchemas;
  const properties = params.properties as AnyRecord | undefined;
  const idProp = properties?.id as AnyRecord | undefined;
  if (!idProp || typeof idProp !== "object") return openApiSchemas;

  const pattern = idProp.pattern;
  const isObjectIdPattern =
    typeof pattern === "string" &&
    (pattern === "^[0-9a-fA-F]{24}$" ||
      pattern === "^[a-f\\d]{24}$" ||
      pattern === "^[a-fA-F0-9]{24}$" ||
      /^\^\[[a-fA-F0-9\\d]+\]\{24\}\$$/.test(pattern));
  if (!isObjectIdPattern) return openApiSchemas;

  const cleanedId: AnyRecord = { ...idProp };
  delete cleanedId.pattern;
  delete cleanedId.minLength;
  delete cleanedId.maxLength;
  if (!cleanedId.description) {
    cleanedId.description = `${idField} (custom ID field)`;
  }
  return {
    ...openApiSchemas,
    params: {
      ...params,
      properties: { ...properties, id: cleanedId },
    } as AnyRecord,
  };
}

function layerQueryParserListQuery(
  openApiSchemas: OpenApiSchemas | undefined,
  queryParser: QueryParserInterface | unknown | undefined,
): OpenApiSchemas | undefined {
  const qp = queryParser as QueryParserInterface | undefined;
  if (!qp?.getQuerySchema) return openApiSchemas;
  const querySchema = qp.getQuerySchema();
  if (!querySchema) return openApiSchemas;
  return {
    ...openApiSchemas,
    listQuery: querySchema as unknown as AnyRecord,
  } as OpenApiSchemas;
}

function mergeUserOpenApiOverrides(
  openApiSchemas: OpenApiSchemas | undefined,
  userOverrides: OpenApiSchemas | undefined,
): OpenApiSchemas | undefined {
  if (!userOverrides) return openApiSchemas;
  return { ...openApiSchemas, ...userOverrides };
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

          // Register first-class actions (v2.8) — after CRUD routes, inside prefix scope.
          //
          // Actions share every cross-cutting primitive with CRUD via
          // `routerShared`: arc decorator (field masking), auth/permission
          // middlewares, pipeline execution, idempotency, rate-limit.
          // Resource-level `fields`, `permissions`, `routeGuards`, `pipe`,
          // `rateLimit`, and `schemaOptions` thread through here so an action
          // endpoint that mutates documents applies the same wiring a PATCH
          // would apply to the same resource.
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
            createActionRouter(typedInstance, {
              ...actionConfig,
              resourceName: self.name,
              fields: self.fields,
              schemaOptions: self.schemaOptions,
              permissions: self.permissions as Record<string, PermissionCheck> | undefined,
              routeGuards: self.routeGuards,
              pipeline: self.pipe,
              rateLimit: self.rateLimit,
            });
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
