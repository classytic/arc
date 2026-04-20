/**
 * RepositoryLike → AuditStore adapter.
 *
 * Maps the audit store's verbs (`log` / `query` / `purgeOlderThan`) onto
 * arc's canonical repository primitives (`create` / `findAll` /
 * `deleteMany`). `auditPlugin` wraps a passed repository with this helper
 * when you use the `{ repository }` option; the function is also re-exported
 * from `@classytic/arc/audit` so consumers can use it as one entry in
 * `customStores: [...]` (fan-out to DB + Kafka/S3) or wrap it with
 * metrics/tracing before registration.
 */

import type { RepositoryLike } from "../adapters/interface.js";
import type { AuditEntry, AuditStore } from "./stores/interface.js";

interface StoredAuditDoc {
  _id?: string;
  id?: string;
  resource?: string;
  documentId?: string;
  action?: AuditEntry["action"];
  userId?: string;
  organizationId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changes?: string[];
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  timestamp?: Date;
}

export function repositoryAsAuditStore(repository: RepositoryLike): AuditStore {
  return {
    name: "repository",

    async log(entry: AuditEntry): Promise<void> {
      // `_id` + `id` both populated so any repository convention works
      // (mongokit uses `_id`; some kits idField-map `id` → `_id`).
      const doc: StoredAuditDoc = {
        _id: entry.id,
        id: entry.id,
        resource: entry.resource,
        documentId: entry.documentId,
        action: entry.action,
        userId: entry.userId,
        organizationId: entry.organizationId,
        before: entry.before,
        after: entry.after,
        changes: entry.changes,
        requestId: entry.requestId,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        metadata: entry.metadata,
        timestamp: entry.timestamp,
      };
      await repository.create(doc);
    },

    async purgeOlderThan(cutoff: Date): Promise<number> {
      if (!repository.deleteMany) {
        // Kits without `deleteMany` (e.g. vanilla mongokit without
        // batchOperationsPlugin) can't purge via arc. Users should add the
        // plugin, register a TTL index on the collection, or run their
        // own cron — we return 0 rather than throw so callers can try all
        // stores uniformly via Promise.all.
        return 0;
      }
      const result = (await repository.deleteMany({
        timestamp: { $lt: cutoff },
      })) as { deletedCount?: number };
      return result.deletedCount ?? 0;
    },

    async query(opts = {}): Promise<AuditEntry[]> {
      if (!repository.getAll) {
        throw new Error(
          "auditPlugin: repository.getAll is required for query(). It's on repo-core's MinimalRepo floor — every kit (mongokit, sqlitekit, custom) implements it.",
        );
      }
      const filter: Record<string, unknown> = {};
      if (opts.resource) filter.resource = opts.resource;
      if (opts.documentId) filter.documentId = opts.documentId;
      if (opts.userId) filter.userId = opts.userId;
      if (opts.organizationId) filter.organizationId = opts.organizationId;
      if (opts.action) {
        const actions = Array.isArray(opts.action) ? opts.action : [opts.action];
        filter.action = actions.length === 1 ? actions[0] : { $in: actions };
      }
      if (opts.from || opts.to) {
        const range: Record<string, unknown> = {};
        if (opts.from) range.$gte = opts.from;
        if (opts.to) range.$lte = opts.to;
        filter.timestamp = range;
      }

      // mongokit's findAll has no skip/limit (options type doesn't include
      // them — they're silently dropped). Use getAll's offset pagination
      // envelope and unwrap .docs. AuditQueryOptions exposes offset-based
      // pagination, mongokit exposes page-based; convert — callers using
      // the standard `offset = (page-1)*limit` pattern get exact results,
      // unaligned offsets round down to the nearest page boundary.
      const limit = opts.limit ?? 100;
      const page = Math.floor((opts.offset ?? 0) / limit) + 1;
      const result = (await repository.getAll({
        filters: filter,
        sort: { timestamp: -1 },
        page,
        limit,
      })) as { docs?: StoredAuditDoc[] } | StoredAuditDoc[];
      const docs: StoredAuditDoc[] = Array.isArray(result) ? result : (result.docs ?? []);
      return docs.map((d) => ({
        id: String(d._id ?? d.id ?? ""),
        resource: d.resource ?? "",
        documentId: d.documentId ?? "",
        action: (d.action ?? "create") as AuditEntry["action"],
        userId: d.userId,
        organizationId: d.organizationId,
        before: d.before,
        after: d.after,
        changes: d.changes,
        requestId: d.requestId,
        ipAddress: d.ipAddress,
        userAgent: d.userAgent,
        metadata: d.metadata,
        timestamp: (d.timestamp as Date) ?? new Date(),
      }));
    },
  };
}
