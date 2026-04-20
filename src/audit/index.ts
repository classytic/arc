/**
 * Audit Module
 *
 * Arc's audit plugin consumes a `RepositoryLike` **directly** — no wrapper
 * classes, no aliases, no proxy stores. Pass your repository (mongokit's
 * `Repository`, prismakit's repo, custom) to the plugin and arc calls
 * `repository.create()` + `repository.findAll()` under the hood.
 *
 * @example
 * ```ts
 * import { auditPlugin } from '@classytic/arc/audit';
 * import { Repository } from '@classytic/mongokit';
 *
 * await fastify.register(auditPlugin, {
 *   enabled: true,
 *   repository: new Repository(AuditEntryModel),
 * });
 *
 * fastify.post('/products', async (request) => {
 *   const product = await createProduct(request.body);
 *   await fastify.audit.create('product', product._id, product, request.auditContext);
 *   return { success: true, data: product };
 * });
 * ```
 *
 * For non-repository backends (Kafka, S3, custom exporters), implement the
 * `AuditStore` interface and pass via `customStores: [...]`.
 */

export type { AuditLogger, AuditPluginOptions } from "./auditPlugin.js";
// Plugin
export {
  auditPlugin as auditPluginFn,
  default as auditPlugin,
} from "./auditPlugin.js";
/**
 * Repository → AuditStore adapter. Use when you want a repo-backed store
 * as one entry in `customStores: [...]` (fan-out to DB + Kafka/S3/etc.),
 * or to decorate the repo store with metrics/tracing before registration.
 * Passing `{ repository }` to the plugin remains the one-liner path.
 */
export { repositoryAsAuditStore } from "./repository-audit-adapter.js";
export type {
  AuditAction,
  AuditContext,
  AuditEntry,
  AuditQueryOptions,
  AuditStore,
  AuditStoreOptions,
  MemoryAuditStoreOptions,
} from "./stores/index.js";
// Stores — memory for tests, plus the AuditStore interface for custom backends.
export {
  createAuditEntry,
  MemoryAuditStore,
} from "./stores/index.js";
