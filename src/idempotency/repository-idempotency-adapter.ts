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
 *
 * Why we DON'T use `StandardRepo.getOrCreate()` — design note for the next
 * reader who wants to "modernize" `tryLock` after the v0.3.x repo-core fix
 * that gave `getOrCreate` a `{ doc, created }` discriminator:
 *
 *   • `tryLock` has TWO race-detection paths in a single primitive:
 *       (a) first-time acquire — no doc for this key yet → insert + win
 *       (b) stale-lease takeover — doc exists, lock expired → REPLACE
 *           the old lock with this caller's lock + win
 *     The current filter `and(eq(idField, key), or(exists("lock", false),
 *     lt("lock.expiresAt", now)))` covers BOTH paths in one atomic
 *     `findOneAndUpdate` round-trip; the dup-key catch disambiguates the
 *     concurrent first-time race (two callers, empty key, both try to
 *     insert — Mongo's unique `_id` index lets exactly one win).
 *
 *   • `getOrCreate(filter, data)` is "if filter matches return existing
 *     doc unchanged; else insert `data`" — it CANNOT mutate an existing
 *     doc. For stale-lease takeover (path b above), the existing stale
 *     row matches `filter`, so `getOrCreate` would return
 *     `{ doc: staleRow, created: false }` and never let the new caller
 *     replace the expired lease. Adopting it for `tryLock` would silently
 *     break stale-lock takeover — a real semantic regression that breaks
 *     the plugin's "crashed handler eventually unblocks" guarantee.
 *
 *   • A two-call hybrid (`getOrCreate` first; on `created: false`,
 *     fall back to `findOneAndUpdate` for the takeover) doubles the
 *     happy-path round-trip count and adds zero correctness — the
 *     single `findOneAndUpdate` already handles both cases atomically.
 *
 *   • `set` always overwrites the response envelope and unsets the lock,
 *     regardless of whether a doc exists. That is "upsert + replace",
 *     not "find or create" — `getOrCreate` doesn't match `set`'s
 *     semantics at all.
 *
 * Constraint: `getOrCreate` is the right primitive for "first-write seeds
 * the row" flows where existing docs are returned untouched. `tryLock`
 * is not such a flow — its definitional purpose is to OVERWRITE expired
 * leases. Keep `findOneAndUpdate`. Locked in by
 * `tests/idempotency/get-or-create-evaluation.test.ts`.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import { and, eq as eqFilter, exists, gt, lt, or, startsWith } from "@classytic/repo-core/filter";
import { update } from "@classytic/repo-core/update";
import { createIsDuplicateKeyError, createSafeGetOne } from "../utils/store-helpers.js";
import type { IdempotencyResult, IdempotencyStore } from "./stores/interface.js";

/**
 * The backing repository returned a document whose key does not match the
 * key that was asked for — which means the repository is NOT applying the
 * key filter. Concretely observed (2026-08-14, be-prod): a Mongoose schema
 * with no declared paths (`new Schema({}, { _id: false })`) under a global
 * `mongoose.set('strictQuery', true)` strips EVERY filter key as an
 * "unknown path", so `getOne({ _id: key })` becomes `getOne({})` — one
 * shared document then absorbs every idempotency key, and every request
 * replays the most recent cached response ACROSS KEYS AND ACROSS USERS
 * (a cancel response for order A was served as "success" for order B,
 * which was never actually canceled).
 *
 * That failure mode is silent by construction — every read "succeeds" with
 * a plausible document — so the adapter verifies the identity of every
 * document it gets back and THROWS this instead of trusting it. Returning
 * `undefined` (treat as miss) would be worse, not safer: the very next
 * `tryLock`/`set` on the same broken repository would corrupt the shared
 * document again.
 *
 * Fix on the host side: declare the key path on the schema (e.g.
 * `_id: String`) and/or set `strictQuery: false` in the SCHEMA options so
 * filters on it are never stripped — see `idempotencyPlugin`'s
 * `repository` option docs.
 */
export class IdempotencyStoreMisconfiguredError extends Error {
  readonly code = "IDEMPOTENCY_STORE_MISCONFIGURED";
  constructor(operation: string, expectedKey: string, actualKey: unknown) {
    super(
      `idempotency repository store: ${operation} for key '${expectedKey}' returned a document ` +
        `keyed '${String(actualKey)}' — the repository is not applying the key filter ` +
        `(commonly: a pathless Mongoose schema under strictQuery:true strips the filter to {}). ` +
        `Declare the key path on the schema (e.g. _id: String) and set strictQuery: false in the ` +
        `schema options. Refusing to serve cross-key results.`,
    );
    this.name = "IdempotencyStoreMisconfiguredError";
  }
}

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

  /**
   * Every document read back MUST carry the key it was fetched by. A
   * mismatch means the repository dropped the filter (see
   * {@link IdempotencyStoreMisconfiguredError}) — fail loud, never serve
   * or mutate a cross-key document.
   */
  function assertKeyIdentity(operation: string, doc: IdempotencyDoc, expectedKey: string): void {
    const actual = doc[idField];
    if (String(actual) !== expectedKey) {
      throw new IdempotencyStoreMisconfiguredError(operation, expectedKey, actual);
    }
  }

  return {
    name: "repository",

    async get(key: string): Promise<IdempotencyResult | undefined> {
      const doc = (await safeGetOne(eqFilter(idField, key))) as IdempotencyDoc | null;
      if (!doc) return undefined;
      assertKeyIdentity("get", doc, key);
      if (!doc.result) return undefined;
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
      const doc = (await r.findOneAndUpdate(
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
          // Stamp the key on the row itself, not only via the upsert filter:
          // when the filter equality survives (healthy repo) this is a no-op
          // write of the same value; it exists so the row is self-describing
          // for the identity checks and for operators inspecting the store.
          setOnInsert: { [idField]: key },
          unset: ["lock"],
        }),
        { upsert: true, returnDocument: "after" },
      )) as IdempotencyDoc | null;
      // A filter-dropping repository matches an arbitrary existing row here
      // and OVERWRITES its cached response — the exact corruption observed
      // live. Verify what we actually wrote to.
      if (doc) assertKeyIdentity("set", doc, key);
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
        const doc = (await r.findOneAndUpdate(
          and(eqFilter(idField, key), or(exists("lock", false), lt("lock.expiresAt", now))),
          update({
            set: { lock: { requestId, expiresAt: lockExpiresAt } },
            setOnInsert: { [idField]: key, createdAt: now, expiresAt: docExpiresAt },
          }),
          { upsert: true, returnDocument: "after" },
        )) as IdempotencyDoc | null;
        // A filter-dropping repository "acquires" the lock on an arbitrary
        // shared row — every caller then wins the same lock and the overlap
        // protection is silently gone. Verify the row is really ours.
        if (doc) assertKeyIdentity("tryLock", doc, key);
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
      // Prefix analog of assertKeyIdentity — a doc whose key does not start
      // with the requested prefix means the filter was dropped.
      if (!String(doc[idField] ?? "").startsWith(prefix)) {
        throw new IdempotencyStoreMisconfiguredError("findByPrefix", prefix, doc[idField]);
      }
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
