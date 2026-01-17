/**
 * Audit Module
 *
 * Optional audit trail with flexible storage options.
 * - MemoryAuditStore: In-process (dev/testing)
 * - MongoAuditStore: MongoDB (production)
 *
 * @example
 * import { auditPlugin } from '@classytic/arc/audit';
 *
 * // Enable audit with MongoDB storage
 * await fastify.register(auditPlugin, {
 *   enabled: true,
 *   stores: ['mongodb'],
 *   mongoConnection: mongoose.connection,
 * });
 *
 * // Use in handlers
 * fastify.post('/products', async (request, reply) => {
 *   const product = await createProduct(request.body);
 *   await fastify.audit.create('product', product._id, product, request.auditContext);
 *   return { success: true, data: product };
 * });
 */

// Plugin
export {
  default as auditPlugin,
  auditPlugin as auditPluginFn,
} from './auditPlugin.js';
export type { AuditPluginOptions, AuditLogger } from './auditPlugin.js';

// Stores
export {
  createAuditEntry,
  MemoryAuditStore,
  MongoAuditStore,
} from './stores/index.js';

export type {
  AuditAction,
  AuditContext,
  AuditEntry,
  AuditQueryOptions,
  AuditStore,
  AuditStoreOptions,
  MemoryAuditStoreOptions,
  MongoAuditStoreOptions,
} from './stores/index.js';
