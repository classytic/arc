/**
 * RepositoryLike → IdempotencyStore adapter.
 *
 * Maps the idempotency store's verbs (get / set / tryLock / unlock / delete /
 * deleteByPrefix / findByPrefix) onto arc's canonical repository primitives
 * (`getOne` / `deleteMany` / `findOneAndUpdate`). `idempotencyPlugin` wraps
 * a passed repository with this helper when you use the `{ repository }`
 * option; the function is also re-exported from `@classytic/arc/idempotency`
 * so consumers can build and decorate the store (metrics, tracing, key
 * namespacing) before passing it via `store:`.
 *
 * Portability: filters compose via `@classytic/repo-core/filter` builders
 * (`and` / `or` / `eq` / `gt` / `lt` / `exists` / `startsWith`) and updates
 * via `@classytic/repo-core/update` (`update({ set, unset, setOnInsert })`).
 * Both IRs compile to Mongo operators on mongokit, SQL predicates on
 * sqlitekit / pgkit, and `WhereInput` / `update` on prismakit. The store
 * therefore runs identically on every backend that implements the
 * `StandardRepo.findOneAndUpdate` + `getOne` + `deleteMany` surface.
 */

import { and, eq as eqFilter, exists, gt, lt, or, startsWith } from "@classytic/repo-core/filter";
import { update } from "@classytic/repo-core/update";
import type { RepositoryLike } from "../adapters/interface.js";
import { createIsDuplicateKeyError, createSafeGetOne } from "../adapters/store-helpers.js";
import type { IdempotencyResult, IdempotencyStore } from "./stores/interface.js";

/**
 * Idempotency document shape. The primary-key field is determined by the
 * kit's `repository.idField` (defaults to `_id` on mongokit, `id` on
 * sqlitekit) — using `Record<string, unknown>` keeps the interface
 * driver-agnostic without fighting the type system over a dynamic key.
 */
interface IdempotencyDoc extends Record<string, unknown> {
  result?: {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
  lock?: { requestId: string; expiresAt: Date };
  createdAt: Date;
  expiresAt: Date;
}

export function repositoryAsIdempotencyStore(
  repository: RepositoryLike,
  defaultTtlMs: number,
): IdempotencyStore {
  const missing: string[] = [];
  if (typeof repository.getOne !== "function") missing.push("getOne");
  if (typeof repository.deleteMany !== "function") missing.push("deleteMany");
  if (typeof repository.findOneAndUpdate !== "function") missing.push("findOneAndUpdate");
  if (missing.length > 0) {
    throw new Error(
      `idempotencyPlugin: repository is missing required methods: ${missing.join(", ")}. ` +
        "mongokit ≥3.8 satisfies these; other kits must implement them to back idempotency via a repository.",
    );
  }
  const r = repository as Required<
    Pick<RepositoryLike, "getOne" | "deleteMany" | "findOneAndUpdate">
  >;

  // Primary-key column name. Kits declare this on `MinimalRepo.idField`
  // (mongokit → '_id', sqlitekit → 'id', others per their schema). Without
  // it we'd hardcode the Mongo convention and break on SQL-backed stores.
  const idField = repository.idField ?? "_id";

  const isDuplicateKeyError = createIsDuplicateKeyError(repository);
  const safeGetOne = createSafeGetOne(repository);

  return {
    name: "repository",

    async get(key: string): Promise<IdempotencyResult | undefined> {
      const doc = (await safeGetOne(eqFilter(idField, key))) as IdempotencyDoc | null;
      if (!doc?.result) return undefined;
      if (new Date(doc.expiresAt) < new Date()) return undefined;
      return {
        key,
        statusCode: doc.result.statusCode,
        headers: doc.result.headers,
        body: doc.result.body,
        createdAt: new Date(doc.createdAt),
        expiresAt: new Date(doc.expiresAt),
      };
    },

    async set(key: string, result: Omit<IdempotencyResult, "key">): Promise<void> {
      await r.findOneAndUpdate(
        eqFilter(idField, key),
        update({
          set: {
            result: {
              statusCode: result.statusCode,
              headers: result.headers,
              body: result.body,
            },
            createdAt: result.createdAt,
            expiresAt: result.expiresAt,
          },
          unset: ["lock"],
        }),
        { upsert: true, returnDocument: "after" },
      );
    },

    async tryLock(key: string, requestId: string, ttlMs: number): Promise<boolean> {
      const now = new Date();
      const lockExpiresAt = new Date(now.getTime() + ttlMs);
      const docExpiresAt = new Date(now.getTime() + defaultTtlMs);
      try {
        // findOneAndUpdate with upsert + compound filter: acquire lock only
        // when no active lock exists. Returns the (pre- or post-update) doc
        // on success; throws a dup-key error on upsert race → return false.
        //
        // Filter IR handles dot-path fields (`lock.expiresAt`) identically
        // across kits — mongokit dot-accesses, SQL kits treat as nested JSON
        // or require flattened columns (backend-specific, documented per kit).
        const doc = await r.findOneAndUpdate(
          and(eqFilter(idField, key), or(exists("lock", false), lt("lock.expiresAt", now))),
          update({
            set: { lock: { requestId, expiresAt: lockExpiresAt } },
            setOnInsert: { createdAt: now, expiresAt: docExpiresAt },
          }),
          { upsert: true, returnDocument: "after" },
        );
        return doc !== null && doc !== undefined;
      } catch (err) {
        if (isDuplicateKeyError(err)) return false;
        throw err;
      }
    },

    async unlock(key: string, requestId: string): Promise<void> {
      await r.findOneAndUpdate(
        and(eqFilter(idField, key), eqFilter("lock.requestId", requestId)),
        update({ unset: ["lock"] }),
      );
    },

    async isLocked(key: string): Promise<boolean> {
      const doc = (await safeGetOne(eqFilter(idField, key))) as IdempotencyDoc | null;
      if (!doc?.lock) return false;
      return new Date(doc.lock.expiresAt) > new Date();
    },

    async delete(key: string): Promise<void> {
      await r.deleteMany(eqFilter(idField, key));
    },

    async deleteByPrefix(prefix: string): Promise<number> {
      // `startsWith` is portable — mongokit compiles to `$regex`, SQL kits
      // compile to `LIKE 'prefix%'`, Prisma to `startsWith`. Wildcard chars
      // in `prefix` (`%`, `_`) are escaped by the builder automatically.
      const result = (await r.deleteMany(startsWith(idField, prefix, "sensitive"))) as {
        deletedCount?: number;
      };
      return result.deletedCount ?? 0;
    },

    async findByPrefix(prefix: string): Promise<IdempotencyResult | undefined> {
      const doc = (await safeGetOne(
        and(
          startsWith(idField, prefix, "sensitive"),
          exists("result", true),
          gt("expiresAt", new Date()),
        ),
      )) as IdempotencyDoc | null;
      if (!doc?.result) return undefined;
      return {
        // Extract the matched doc's key via the configured `idField` —
        // returning `doc._id` would break on SQL kits where the column is `id`.
        key: String(doc[idField] ?? prefix),
        statusCode: doc.result.statusCode,
        headers: doc.result.headers,
        body: doc.result.body,
        createdAt: new Date(doc.createdAt),
        expiresAt: new Date(doc.expiresAt),
      };
    },

    async close(): Promise<void> {
      // Repository lifecycle is owned by the caller.
    },
  };
}
