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
import { hasEvents } from "../utils/typeGuards.js";
import type {
  AdditionalRoute,
  AnyRecord,
  CrudController,
  CrudRouteKey,
  CrudSchemas,
  EventDefinition,
  FastifyWithDecorators,
  IController,
  MiddlewareConfig,
  OpenApiSchemas,
  QueryParserInterface,
  RateLimitConfig,
  ResourceCacheConfig,
  ResourceConfig,
  ResourceMetadata,
  ResourcePermissions,
  RouteSchemaOptions,
} from "../types/index.js";
import type { DataAdapter } from "../adapters/interface.js";
import { BaseController } from "./BaseController.js";
import { createCrudRouter } from "./createCrudRouter.js";
import { applyPresets } from "../presets/index.js";
import type { RegisterOptions } from "../registry/ResourceRegistry.js";
import { assertValidConfig } from "./validateResourceConfig.js";
import {
  convertOpenApiSchemas,
  convertRouteSchema,
} from "../utils/schemaConverter.js";
import { CRUD_OPERATIONS } from "../constants.js";

interface ExtendedResourceConfig<
  TDoc = AnyRecord,
> extends ResourceConfig<TDoc> {
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

    // Validate additionalRoutes
    for (const route of config.additionalRoutes ?? []) {
      if (typeof route.permissions !== "function") {
        throw new Error(
          `[Arc] Resource '${config.name}' route ${route.method} ${route.path}: ` +
            `permissions is required and must be a PermissionCheck function.\n` +
            `Use allowPublic() or requireAuth() from @classytic/arc/permissions.`,
        );
      }
      if (typeof route.wrapHandler !== "boolean") {
        throw new Error(
          `[Arc] Resource '${config.name}' route ${route.method} ${route.path}: ` +
            `wrapHandler is required.\n` +
            `Set true for ControllerHandler (context object) or false for FastifyHandler (req, reply).`,
        );
      }
    }
  }

  // Extract repository from adapter (if provided)
  const repository = config.adapter?.repository;

  // Check if any CRUD routes will actually be created
  const crudRoutes = CRUD_OPERATIONS;
  const disabledRoutes = new Set(config.disabledRoutes ?? []);
  const hasCrudRoutes =
    !config.disableDefaultRoutes &&
    crudRoutes.some((route) => !disabledRoutes.has(route));

  // 2. Track presets
  const originalPresets = (config.presets ?? []).map((p) =>
    typeof p === "string" ? p : (p as { name: string }).name,
  );

  // 3. Apply presets FIRST before controller instantiation
  const resolvedConfig = (
    config.presets?.length ? applyPresets(config, config.presets) : config
  ) as ExtendedResourceConfig<TDoc>;

  resolvedConfig._appliedPresets = originalPresets;

  // 4. Create or use provided controller using the full resolved config
  let controller = resolvedConfig.controller;
  if (!controller && hasCrudRoutes && repository) {
    // Auto-create BaseController if CRUD routes exist
    controller = new BaseController<TDoc>(repository, {
      resourceName: resolvedConfig.name,
      schemaOptions: resolvedConfig.schemaOptions,
      queryParser: resolvedConfig.queryParser as
        | QueryParserInterface
        | undefined,
      tenantField: resolvedConfig.tenantField,
      idField: resolvedConfig.idField,
      matchesFilter: config.adapter?.matchesFilter,
      cache: resolvedConfig.cache,
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

  // Auto-register with OpenAPI schemas
  if (!config.skipRegistry) {
    try {
      // Get schemas: user-provided or auto-generate from adapter
      let openApiSchemas: OpenApiSchemas | undefined = config.openApiSchemas;

      // Auto-generate if not provided and adapter supports it
      if (!openApiSchemas && config.adapter?.generateSchemas) {
        const generated = config.adapter.generateSchemas(config.schemaOptions);
        if (generated) {
          openApiSchemas = generated;
        }
      }

      // Auto-detect listQuery schema from queryParser (if not already provided)
      const queryParser = config.queryParser as
        | QueryParserInterface
        | undefined;
      if (!openApiSchemas?.listQuery && queryParser?.getQuerySchema) {
        const querySchema = queryParser.getQuerySchema();
        if (querySchema) {
          openApiSchemas = {
            ...openApiSchemas,
            listQuery: querySchema as unknown as AnyRecord,
          };
        }
      }

      // Auto-convert Zod schemas to JSON Schema (no-op for plain JSON Schema)
      if (openApiSchemas) {
        openApiSchemas = convertOpenApiSchemas(openApiSchemas);
      }

      // Store registry metadata for lazy registration when toPlugin() is called
      resource._registryMeta = {
        module: config.module,
        openApiSchemas,
      };
    } catch {
      // Schema generation errors are non-fatal — resource still works without OpenAPI metadata
    }
  }

  return resource;
}

interface ResolvedResourceConfig<
  TDoc = AnyRecord,
> extends ResourceConfig<TDoc> {
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

  // Customization
  readonly additionalRoutes: AdditionalRoute[];
  readonly middlewares: MiddlewareConfig;
  readonly disableDefaultRoutes: boolean;
  readonly disabledRoutes: CrudRouteKey[];

  // Events
  readonly events: Record<string, EventDefinition>;

  // Rate limiting
  readonly rateLimit?: RateLimitConfig | false;

  // Update method
  readonly updateMethod?: "PUT" | "PATCH" | "both";

  // Pipeline
  readonly pipe?: import("../pipeline/types.js").PipelineConfig;

  // Field-level permissions
  readonly fields?: import("../permissions/fields.js").FieldPermissionMap;

  // Cache config
  readonly cache?: ResourceCacheConfig;

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
    this.displayName = config.displayName ?? capitalize(config.name) + "s";
    this.tag = config.tag ?? this.displayName;
    this.prefix = config.prefix ?? `/${config.name}s`;

    // Adapter
    this.adapter = config.adapter;

    // Controller
    this.controller = config.controller as IController<TDoc> | undefined;

    // Schema & Validation
    this.schemaOptions = config.schemaOptions ?? {};
    this.customSchemas = config.customSchemas ?? {};

    // Security
    this.permissions = (config.permissions ?? {}) as ResourcePermissions;

    // Customization
    this.additionalRoutes = config.additionalRoutes ?? [];
    this.middlewares = config.middlewares ?? {};
    this.disableDefaultRoutes = config.disableDefaultRoutes ?? false;
    this.disabledRoutes = config.disabledRoutes ?? [];

    // Events
    this.events = config.events ?? {};

    // Rate limiting
    this.rateLimit = config.rateLimit;

    // Update method
    this.updateMethod = config.updateMethod;

    // Pipeline
    this.pipe = config.pipe;

    // Field-level permissions
    this.fields = config.fields;

    // Cache config
    this.cache = config.cache;

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
    const enabledCrudRoutes = crudRoutes.filter(
      (route) => !disabledRoutes.has(route),
    );
    const hasCrudRoutes =
      !this.disableDefaultRoutes && enabledCrudRoutes.length > 0;

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

    for (const route of this.additionalRoutes) {
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
          (registerRule as (rule: { pattern: string; tags: string[] }) => void)(
            { pattern, tags },
          );
        }
      }

      await fastify.register(
        async (instance) => {
          const typedInstance = instance as FastifyWithDecorators;

          // Schema generation is handled at define-time (see defineResource, lines ~222-230).
          // No competing runtime generation here.
          let schemas: CrudSchemas | null = null;

          // Merge custom schemas (auto-convert Zod schemas within)
          // Uses convertRouteSchema which properly handles nested response schemas
          // e.g. { body: z.object(...), response: { 201: z.object(...) } }
          if (
            self.customSchemas &&
            Object.keys(self.customSchemas).length > 0
          ) {
            schemas = schemas ?? {};
            for (const [op, customSchema] of Object.entries(
              self.customSchemas,
            )) {
              const key = op as keyof CrudSchemas;
              const converted = convertRouteSchema(
                customSchema as Record<string, unknown>,
              );
              schemas[key] = schemas[key]
                ? deepMergeSchemas(
                    schemas[key] as AnyRecord,
                    converted as AnyRecord,
                  )
                : (converted as AnyRecord);
            }
          }

          // Pass routes as-is to createCrudRouter
          // String handler resolution and wrapping is handled in createCrudRouter
          const resolvedRoutes = self.additionalRoutes;

          // Create CRUD routes
          createCrudRouter(
            typedInstance,
            self.controller as unknown as CrudController<TDoc>,
            {
              tag: self.tag,
              schemas: schemas ?? undefined,
              permissions: self.permissions,
              middlewares: self.middlewares,
              additionalRoutes: resolvedRoutes,
              disableDefaultRoutes: self.disableDefaultRoutes,
              disabledRoutes: self.disabledRoutes,
              resourceName: self.name,
              schemaOptions: self.schemaOptions,
              rateLimit: self.rateLimit,
              updateMethod: self.updateMethod,
              pipe: self.pipe,
              fields: self.fields,
            },
          );

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
      additionalRoutes: this.additionalRoutes,
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
      result[key] = deepMergeSchemas(
        result[key] as AnyRecord,
        value as AnyRecord,
      );
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

export default defineResource;
