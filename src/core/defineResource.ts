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

import type { FastifyPluginAsync } from 'fastify';
import type { Model, Document } from 'mongoose';
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
  ResourceConfig,
  ResourceMetadata,
  ResourcePermissions,
  RouteSchemaOptions,
} from '../types/index.js';
import type { DataAdapter } from '../adapters/interface.js';
import { BaseController } from './BaseController.js';
import { createCrudRouter } from './createCrudRouter.js';
import { applyPresets } from '../presets/index.js';
import { resourceRegistry } from '../registry/index.js';
import { assertValidConfig } from './validateResourceConfig.js';
import { hookSystem } from '../hooks/index.js';

interface ExtendedResourceConfig<TDoc = AnyRecord> extends ResourceConfig<TDoc> {
  _appliedPresets?: string[];
  _controllerOptions?: {
    slugField?: string;
    parentField?: string;
    [key: string]: unknown;
  };
  _hooks?: Array<{
    presetName: string;
    operation: 'create' | 'update' | 'delete' | 'read' | 'list';
    phase: 'before' | 'after';
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
  config: ResourceConfig<TDoc>
): ResourceDefinition<TDoc> {
  // Fail-fast validation
  if (!config.skipValidation) {
    assertValidConfig(config as ResourceConfig<AnyRecord>, { skipControllerCheck: true });

    // Validate permissions are PermissionCheck functions
    if (config.permissions) {
      for (const [key, value] of Object.entries(config.permissions)) {
        if (value !== undefined && typeof value !== 'function') {
          throw new Error(
            `[Arc] Resource '${config.name}': permissions.${key} must be a PermissionCheck function.\n` +
            `Use allowPublic(), requireAuth(), or requireRoles(['role']) from @classytic/arc/permissions.`
          );
        }
      }
    }

    // Validate additionalRoutes
    for (const route of config.additionalRoutes ?? []) {
      if (typeof route.permissions !== 'function') {
        throw new Error(
          `[Arc] Resource '${config.name}' route ${route.method} ${route.path}: ` +
          `permissions is required and must be a PermissionCheck function.\n` +
          `Use allowPublic() or requireAuth() from @classytic/arc/permissions.`
        );
      }
      if (typeof route.wrapHandler !== 'boolean') {
        throw new Error(
          `[Arc] Resource '${config.name}' route ${route.method} ${route.path}: ` +
          `wrapHandler is required.\n` +
          `Set true for ControllerHandler (context object) or false for FastifyHandler (req, reply).`
        );
      }
    }
  }

  // Extract repository from adapter (if provided)
  const repository = config.adapter?.repository;

  // Create or use provided controller
  let controller = config.controller;
  if (!controller && !config.disableDefaultRoutes && repository) {
    // Auto-create BaseController if not provided
    controller = new BaseController(repository, {
      resourceName: config.name,
      schemaOptions: config.schemaOptions,
      queryParser: config.queryParser as any,
    }) as IController<TDoc>;
  }

  // Track presets
  const originalPresets = (config.presets ?? []).map((p) =>
    typeof p === 'string' ? p : (p as any).name
  );

  // Apply presets
  const resolvedConfig = (config.presets?.length
    ? applyPresets(config, config.presets)
    : config) as ExtendedResourceConfig<TDoc>;

  resolvedConfig._appliedPresets = originalPresets;

  // Inject controller options
  if (controller) {
    const ctrl = controller as {
      _setResourceOptions?: (options: {
        schemaOptions?: RouteSchemaOptions;
        presetFields?: { slugField?: string; parentField?: string };
        resourceName?: string;
        queryParser?: QueryParserInterface;
      }) => void;
    };

    if (typeof ctrl._setResourceOptions === 'function') {
      ctrl._setResourceOptions({
        schemaOptions: resolvedConfig.schemaOptions,
        presetFields: resolvedConfig._controllerOptions
          ? {
              slugField: resolvedConfig._controllerOptions.slugField,
              parentField: resolvedConfig._controllerOptions.parentField,
            }
          : undefined,
        resourceName: resolvedConfig.name,
        queryParser: resolvedConfig.queryParser as any,
      });
    }
  }

  const resource = new ResourceDefinition({
    ...resolvedConfig,
    adapter: config.adapter,
    controller,
  } as ResolvedResourceConfig<TDoc>);

  // Validate controller methods
  if (!config.skipValidation && controller) {
    resource._validateControllerMethods();
  }

  // Register hooks from presets
  if (resolvedConfig._hooks?.length) {
    for (const hook of resolvedConfig._hooks) {
      hookSystem.register({
        resource: resolvedConfig.name,
        operation: hook.operation,
        phase: hook.phase,
        handler: hook.handler as unknown as (ctx: { resource: string; operation: string; phase: string; data?: AnyRecord }) => AnyRecord | Promise<AnyRecord>,
        priority: hook.priority ?? 10,
      });
    }
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
      const queryParser = config.queryParser as any;
      if (!openApiSchemas?.listQuery && queryParser?.getQuerySchema) {
        const querySchema = queryParser.getQuerySchema();
        if (querySchema) {
          openApiSchemas = {
            ...openApiSchemas,
            listQuery: querySchema as unknown as AnyRecord,
          };
        }
      }

      resourceRegistry.register(resource as unknown as ResourceDefinition<AnyRecord>, {
        module: config.module,
        openApiSchemas,
      });
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[Arc Registry] ${(err as Error).message}`);
      }
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
  readonly organizationScoped: boolean;

  // Events
  readonly events: Record<string, EventDefinition>;

  // Presets tracking
  readonly _appliedPresets: string[];

  constructor(config: ResolvedResourceConfig<TDoc>) {
    // Identity
    this.name = config.name;
    this.displayName = config.displayName ?? capitalize(config.name) + 's';
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
    this.organizationScoped = config.organizationScoped ?? false;

    // Events
    this.events = config.events ?? {};

    // Presets tracking
    this._appliedPresets = config._appliedPresets ?? [];
  }

  /** Get repository from adapter (if available) */
  get repository() {
    return this.adapter?.repository;
  }

  /** Get model from adapter (if available) */
  get model(): Model<Document> | unknown | undefined {
    if (!this.adapter) return undefined;
    return this.adapter.getSchemaMetadata?.()
      ? (this.adapter as { model?: Model<Document> }).model
      : undefined;
  }

  _validateControllerMethods(): void {
    const errors: string[] = [];

    if (!this.disableDefaultRoutes) {
      if (!this.controller) {
        errors.push('Controller is required when disableDefaultRoutes is not true');
      } else {
        const ctrl = this.controller as unknown as AnyRecord;
        const requiredMethods = ['list', 'get', 'create', 'update', 'delete'] as const;
        for (const method of requiredMethods) {
          if (typeof ctrl[method] !== 'function') {
            errors.push(`CRUD method '${method}' not found on controller`);
          }
        }
      }
    }

    for (const route of this.additionalRoutes) {
      if (typeof route.handler === 'string') {
        if (!this.controller) {
          errors.push(
            `Route ${route.method} ${route.path}: string handler '${route.handler}' requires a controller`
          );
        } else {
          const ctrl = this.controller as unknown as Record<string, unknown>;
          if (typeof ctrl[route.handler] !== 'function') {
            errors.push(
              `Route ${route.method} ${route.path}: handler '${route.handler}' not found`
            );
          }
        }
      }
    }

    if (errors.length > 0) {
      const errorMsg = [
        `Resource '${this.name}' validation failed:`,
        ...errors.map((e) => `  - ${e}`),
        '',
        'Ensure controller implements IController<TDoc> interface.',
        'For preset routes (softDelete, tree), add corresponding methods to controller.',
      ].join('\n');

      throw new Error(errorMsg);
    }
  }

  toPlugin(): FastifyPluginAsync {
    const self = this;

    return async function resourcePlugin(fastify, _opts): Promise<void> {
      await fastify.register(async (instance) => {
        const typedInstance = instance as FastifyWithDecorators;

        // Generate schemas from adapter metadata (if adapter exists)
        let schemas: CrudSchemas | null = null;
        if (self.adapter) {
          const metadata = self.adapter.getSchemaMetadata?.();

          if (metadata && typedInstance.generateSchemas) {
            // Try to generate from model if available (Mongoose)
            const model = (self.adapter as { model?: Model<Document> }).model;
            if (model && typeof (typedInstance as any).generateSchemas === 'function') {
              schemas = (typedInstance as any).generateSchemas(model, self.schemaOptions);
            }
          }
        }

        // Merge custom schemas
        if (self.customSchemas && Object.keys(self.customSchemas).length > 0) {
          schemas = schemas ?? {};
          for (const [op, customSchema] of Object.entries(self.customSchemas)) {
            const key = op as keyof CrudSchemas;
            schemas[key] = schemas[key]
              ? deepMergeSchemas(schemas[key] as AnyRecord, customSchema as AnyRecord)
              : customSchema;
          }
        }

        // Pass routes as-is to createCrudRouter
        // String handler resolution and wrapping is handled in createCrudRouter
        const resolvedRoutes = self.additionalRoutes;

        // Create CRUD routes
        createCrudRouter(typedInstance, self.controller as unknown as CrudController<TDoc>, {
          tag: self.tag,
          schemas: schemas ?? undefined,
          permissions: self.permissions,
          middlewares: self.middlewares,
          additionalRoutes: resolvedRoutes,
          disableDefaultRoutes: self.disableDefaultRoutes,
          disabledRoutes: self.disabledRoutes,
          organizationScoped: self.organizationScoped,
          resourceName: self.name,
          schemaOptions: self.schemaOptions,
        });

        if (self.events && Object.keys(self.events).length > 0) {
          typedInstance.log?.info?.(
            `Resource '${self.name}' defined ${Object.keys(self.events).length} events`
          );
        }
      }, { prefix: self.prefix });
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
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMergeSchemas(result[key] as AnyRecord, value as AnyRecord);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export default defineResource;
