/**
 * Internal: RepositoryLike → AuditStore inline adapter.
 *
 * Maps the audit store's two verbs (`log` / `query`) onto arc's canonical
 * repository primitives (`create` / `findAll`). Not exported publicly —
 * `auditPlugin` wraps a passed repository with this helper when you use
 * the `{ repository }` option.
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

    async query(opts = {}): Promise<AuditEntry[]> {
      if (!repository.findAll) {
        throw new Error(
          "auditPlugin: repository.findAll is required for query(). mongokit ≥3.6 implements it; other kits should match.",
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
      const docs = (await repository.findAll(filter, {
        sort: { timestamp: -1 },
        skip: opts.offset ?? 0,
        limit: opts.limit ?? 100,
      })) as StoredAuditDoc[];
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
