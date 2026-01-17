/**
 * Registry Module
 *
 * Resource registry and introspection.
 *
 * @example
 * import { resourceRegistry, introspectionPlugin } from '@classytic/arc/registry';
 *
 * // Register introspection endpoints
 * await fastify.register(introspectionPlugin, {
 *   prefix: '/_resources',
 *   authRoles: ['superadmin'],
 * });
 *
 * // Access registry programmatically
 * const allResources = resourceRegistry.getAll();
 * const stats = resourceRegistry.getStats();
 */

export {
  ResourceRegistry,
  resourceRegistry,
} from './ResourceRegistry.js';
export type { RegisterOptions } from './ResourceRegistry.js';

export {
  default as introspectionPlugin,
  introspectionPlugin as introspectionPluginFn,
} from './introspectionPlugin.js';
export type { IntrospectionPluginOptions } from './introspectionPlugin.js';
