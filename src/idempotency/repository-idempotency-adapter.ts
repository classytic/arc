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
 * Requires mongokit ≥3.10 (or equivalent) — `findOneAndUpdate` is essential
 * for the atomic upsert + conditional-lock handshake.
 */

import type { RepositoryLike } from "../adapters/interface.js";
import { createIsDuplicateKeyError, createSafeGetOne } from "../adapters/store-helpers.js";
import type { IdempotencyResult, IdempotencyStore } from "./stores/interface.js";

interface IdempotencyDoc {
  _id: string;
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

  const isDuplicateKeyError = createIsDuplicateKeyError(repository);
  const safeGetOne = createSafeGetOne(repository);
  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return {
    name: "repository",

    async get(key: string): Promise<IdempotencyResult | undefined> {
      const doc = (await safeGetOne({ _id: key })) as IdempotencyDoc | null;
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
        { _id: key },
        {
          $set: {
            result: {
              statusCode: result.statusCode,
              headers: result.headers,
              body: result.body,
            },
            createdAt: result.createdAt,
            expiresAt: result.expiresAt,
          },
          $unset: { lock: "" },
        },
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
        const doc = await r.findOneAndUpdate(
          {
            _id: key,
            $or: [{ lock: { $exists: false } }, { "lock.expiresAt": { $lt: now } }],
          },
          {
            $set: { lock: { requestId, expiresAt: lockExpiresAt } },
            $setOnInsert: { createdAt: now, expiresAt: docExpiresAt },
          },
          { upsert: true, returnDocument: "after" },
        );
        return doc !== null && doc !== undefined;
      } catch (err) {
        if (isDuplicateKeyError(err)) return false;
        throw err;
      }
    },

    async unlock(key: string, requestId: string): Promise<void> {
      await r.findOneAndUpdate({ _id: key, "lock.requestId": requestId }, { $unset: { lock: "" } });
    },

    async isLocked(key: string): Promise<boolean> {
      const doc = (await safeGetOne({ _id: key })) as IdempotencyDoc | null;
      if (!doc?.lock) return false;
      return new Date(doc.lock.expiresAt) > new Date();
    },

    async delete(key: string): Promise<void> {
      await r.deleteMany({ _id: key });
    },

    async deleteByPrefix(prefix: string): Promise<number> {
      const result = (await r.deleteMany({
        _id: { $regex: `^${escapeRegex(prefix)}` },
      })) as { deletedCount?: number };
      return result.deletedCount ?? 0;
    },

    async findByPrefix(prefix: string): Promise<IdempotencyResult | undefined> {
      const doc = (await safeGetOne({
        _id: { $regex: `^${escapeRegex(prefix)}` },
        result: { $exists: true },
        expiresAt: { $gt: new Date() },
      })) as IdempotencyDoc | null;
      if (!doc?.result) return undefined;
      return {
        key: doc._id,
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
