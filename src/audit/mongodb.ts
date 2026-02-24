/**
 * MongoDB Audit Store — Dedicated Entry Point
 *
 * Import from '@classytic/arc/audit/mongodb' to avoid pulling mongoose
 * into your bundle when using in-memory audit store.
 *
 * @example
 * import { MongoAuditStore } from '@classytic/arc/audit/mongodb';
 *
 * await fastify.register(auditPlugin, {
 *   enabled: true,
 *   store: new MongoAuditStore({ connection: mongoose.connection }),
 * });
 */
export { MongoAuditStore } from './stores/mongodb.js';
export type { MongoAuditStoreOptions } from './stores/mongodb.js';
