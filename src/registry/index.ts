/**
 * Registry Module
 *
 * Resource registry and introspection.
 *
 * @example
 * import { ResourceRegistry, introspectionPlugin } from '@classytic/arc/registry';
 *
 * // Register introspection endpoints
 * await fastify.register(introspectionPlugin, {
 *   prefix: '/_resources',
 *   authRoles: ['superadmin'],
 * });
 *
 * // Access registry programmatically (instance-scoped via fastify.arc.registry)
 * const allResources = fastify.arc.registry.getAll();
 * const stats = fastify.arc.registry.getStats();
 */

export {
  ResourceRegistry,
} from './ResourceRegistry.js';
export type { RegisterOptions } from './ResourceRegistry.js';

export {
  default as introspectionPlugin,
  introspectionPlugin as introspectionPluginFn,
} from './introspectionPlugin.js';
export type { IntrospectionPluginOptions } from './introspectionPlugin.js';
