/**
 * RepositoryLike → AuditStore adapter.
 *
 * Maps the audit store's verbs (`log` / `query` / `purgeOlderThan`) onto
 * arc's canonical repository primitives (`create` / `getAll` /
 * `deleteMany`). `auditPlugin` wraps a passed repository with this helper
 * when you use the `{ repository }` option; the function is also re-exported
 * from `@classytic/arc/audit` so consumers can use it as one entry in
 * `customStores: [...]` (fan-out to DB + Kafka/S3) or wrap it with
 * metrics/tracing before registration.
 *
 * Portability: filter composition uses `@classytic/repo-core/filter`
 * builders, so the adapter compiles identically against mongokit
 * (`$in` / `$gte` / `$lte` records) and sqlitekit (`IN (...)` / `>=` /
 * `<=` predicates). The primary-key column name is read from
 * `repository.idField` — mongokit defaults to `_id`, sqlitekit to `id`.
 */

import type { Filter } from "@classytic/repo-core/filter";
import { and, anyOf, eq, gte, lt, lte } from "@classytic/repo-core/filter";
import type { RepositoryLike } from "../adapters/interface.js";
import type { AuditEntry, AuditStore } from "./stores/interface.js";

/**
 * Stored audit row shape. Declared loose — the PK field name is the
 * kit's `idField`, not a hardcoded `_id`.
 */
interface StoredAuditDoc extends Record<string, unknown> {
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
  // Primary-key column name per the kit's contract (mongokit → `_id`,
  // sqlitekit → `id`). Previously the adapter hardcoded both keys on
  // write, which happened to work because mongokit honored `_id` and SQL
  // kits happened to have a column named `id`. This is the principled
  // equivalent — one column name, chosen by the kit.
  const idField = repository.idField ?? "_id";

  return {
    name: "repository",

    async log(entry: AuditEntry): Promise<void> {
      const doc: StoredAuditDoc = {
        [idField]: entry.id,
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
        // Non-conforming repositories (not StandardRepo) can't purge via
        // arc. Users should upgrade to a conforming kit (repo-core 0.2+
        // requires deleteMany on StandardRepo) or register a TTL index /
        // cron — we return 0 rather than throw so callers can try all
        // stores uniformly via Promise.all.
        return 0;
      }
      const result = (await repository.deleteMany(lt("timestamp", cutoff))) as {
        deletedCount?: number;
      };
      return result.deletedCount ?? 0;
    },

    async query(opts = {}): Promise<AuditEntry[]> {
      if (!repository.getAll) {
        throw new Error(
          "auditPlugin: repository.getAll is required for query(). It's on repo-core's MinimalRepo floor — every kit (mongokit, sqlitekit, custom) implements it.",
        );
      }

      // Build the filter by composing IR nodes. Empty clauses short-circuit
      // to `undefined` so `and(...)` only wraps populated predicates.
      const clauses: Filter[] = [];
      if (opts.resource) clauses.push(eq("resource", opts.resource));
      if (opts.documentId) clauses.push(eq("documentId", opts.documentId));
      if (opts.userId) clauses.push(eq("userId", opts.userId));
      if (opts.organizationId) clauses.push(eq("organizationId", opts.organizationId));
      if (opts.action) {
        const actions = Array.isArray(opts.action) ? opts.action : [opts.action];
        clauses.push(actions.length === 1 ? eq("action", actions[0]) : anyOf("action", actions));
      }
      if (opts.from) clauses.push(gte("timestamp", opts.from));
      if (opts.to) clauses.push(lte("timestamp", opts.to));

      // `filters: undefined` falls back to "no predicate" on every kit,
      // which is the correct default when the caller passes no filter
      // options at all. `and(...)` with zero children returns `TRUE`,
      // which mongokit treats as "match all" — equivalent but explicit.
      const filters: Filter | undefined = clauses.length > 0 ? and(...clauses) : undefined;

      // AuditQueryOptions exposes offset-based pagination; repo-core's
      // `PaginationParams` uses page-based. Convert — callers using the
      // standard `offset = (page-1)*limit` pattern get exact results,
      // unaligned offsets round down to the nearest page boundary.
      const limit = opts.limit ?? 100;
      const page = Math.floor((opts.offset ?? 0) / limit) + 1;
      const result = (await repository.getAll({
        ...(filters ? { filters } : {}),
        sort: { timestamp: -1 },
        page,
        limit,
      })) as { docs?: StoredAuditDoc[] } | StoredAuditDoc[];
      const docs: StoredAuditDoc[] = Array.isArray(result) ? result : (result.docs ?? []);
      return docs.map((d) => ({
        // Extract the matched doc's id via the kit's idField — returning
        // `d._id` only would break on SQL kits where the column is `id`.
        id: String(d[idField] ?? ""),
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
