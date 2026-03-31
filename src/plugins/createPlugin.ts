/**
 * createPlugin() — forRoot/forFeature Pattern
 *
 * Standard pattern for plugins that need both global setup and per-resource configuration.
 * Inspired by NestJS forRoot/forFeature but simpler — plain functions, no decorators.
 *
 * @example
 * ```typescript
 * // Define a plugin with global + per-resource config
 * const analytics = createPlugin('analytics', {
 *   forRoot: async (fastify, opts) => {
 *     // Global setup: connect to analytics service, add decorators
 *     const client = new AnalyticsClient(opts.apiKey);
 *     fastify.decorate('analytics', client);
 *   },
 *   forResource: (resourceConfig, opts) => {
 *     // Per-resource: return hooks, middleware, or routes
 *     return {
 *       hooks: [{
 *         operation: 'create', phase: 'after', priority: 100,
 *         handler: (ctx) => client.track('created', ctx.result),
 *       }],
 *     };
 *   },
 * });
 *
 * // Usage — register globally once
 * await app.register(analytics.forRoot({ apiKey: 'xxx' }));
 *
 * // Then apply per-resource
 * const productResource = defineResource({
 *   name: 'product',
 *   adapter: productAdapter,
 *   ...analytics.forResource({ trackEvents: true }),
 * });
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type {
  AdditionalRoute,
  AnyRecord,
  MiddlewareConfig,
  PresetHook,
  RouteSchemaOptions,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginResourceResult {
  /** Additional routes to add to the resource */
  additionalRoutes?: AdditionalRoute[];
  /** Middlewares per operation */
  middlewares?: MiddlewareConfig;
  /** Hooks to register */
  hooks?: PresetHook[];
  /** Schema options to merge */
  schemaOptions?: RouteSchemaOptions;
}

export interface CreatePluginDefinition<
  TRootOpts extends AnyRecord = AnyRecord,
  TResourceOpts extends AnyRecord = AnyRecord,
> {
  /**
   * Global setup function. Called once when the plugin is registered on the Fastify instance.
   * Use this for database connections, decorators, shared state, etc.
   */
  forRoot?: (fastify: FastifyInstance, opts: TRootOpts) => void | Promise<void>;

  /**
   * Per-resource configuration function. Called for each resource that uses this plugin.
   * Returns hooks, routes, middlewares, etc. to merge into the resource config.
   */
  forResource?: (resourceConfig: AnyRecord, opts: TResourceOpts) => PluginResourceResult;
}

export interface ArcPlugin<
  TRootOpts extends AnyRecord = AnyRecord,
  TResourceOpts extends AnyRecord = AnyRecord,
> {
  /** Plugin name */
  readonly name: string;

  /**
   * Register the plugin globally on a Fastify instance.
   * Returns a Fastify plugin that can be passed to `app.register()`.
   */
  forRoot(opts?: TRootOpts): FastifyPluginAsync<TRootOpts>;

  /**
   * Apply per-resource configuration.
   * Returns a partial resource config to spread into `defineResource()`.
   */
  forResource(opts?: TResourceOpts): PluginResourceResult;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a structured plugin with forRoot (global) and forResource (per-resource) support.
 *
 * @param name - Plugin name (used for Fastify registration and debugging)
 * @param definition - Plugin setup functions
 * @returns ArcPlugin with forRoot() and forResource() methods
 */
export function createPlugin<
  TRootOpts extends AnyRecord = AnyRecord,
  TResourceOpts extends AnyRecord = AnyRecord,
>(
  name: string,
  definition: CreatePluginDefinition<TRootOpts, TResourceOpts>,
): ArcPlugin<TRootOpts, TResourceOpts> {
  return {
    name,

    forRoot(opts?: TRootOpts): FastifyPluginAsync<TRootOpts> {
      const plugin: FastifyPluginAsync<TRootOpts> = async (fastify, pluginOpts) => {
        const mergedOpts = { ...opts, ...pluginOpts } as TRootOpts;
        if (definition.forRoot) {
          await definition.forRoot(fastify, mergedOpts);
        }
      };

      return fp(plugin, {
        name: `arc-plugin-${name}`,
        fastify: "5.x",
      });
    },

    forResource(opts?: TResourceOpts): PluginResourceResult {
      if (!definition.forResource) {
        return {};
      }
      return definition.forResource({} as AnyRecord, (opts ?? {}) as TResourceOpts);
    },
  };
}
