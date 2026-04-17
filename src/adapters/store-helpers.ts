/**
 * Internal: shared helpers for `repositoryAs*` store adapters.
 *
 * The audit / outbox / idempotency adapters all wrap a `RepositoryLike` to
 * back a store. Two pieces of cross-kit error normalization are identical
 * across them and live here so a new driver code (Prisma, Drizzle, Neo4j,
 * etc.) only has to be added in one place.
 *
 * Not exported from the adapters barrel — internal to arc's store adapters.
 */

import type { RepositoryLike } from "./interface.js";

/**
 * Classify an error thrown by `getOne` / `getById` / `update` as a
 * "document not found" miss. Mongokit uses `status: 404`, Prisma uses
 * `code: 'P2025'`, some kits throw `DocumentNotFoundError`. Kits that
 * return `null` on miss never see this predicate fire — it only kicks in
 * when a driver chose to throw.
 */
export function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    statusCode?: number;
    code?: string;
    name?: string;
  };
  if (e.status === 404 || e.statusCode === 404) return true; // mongokit
  if (e.code === "P2025") return true; // Prisma
  if (e.name === "DocumentNotFoundError") return true;
  return false;
}

/**
 * Build a `safeGetOne(filter)` that papers over the throw-vs-null split
 * in kit implementations. Real errors propagate; miss returns `null`.
 * Throws if the repository lacks `getOne` — callers must check.
 */
export function createSafeGetOne(
  repository: RepositoryLike,
): (filter: Record<string, unknown>) => Promise<unknown | null> {
  if (typeof repository.getOne !== "function") {
    throw new Error("createSafeGetOne: repository.getOne is required");
  }
  const getOne = repository.getOne.bind(repository);
  return async (filter) => {
    try {
      const doc = await getOne(filter);
      return doc ?? null;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  };
}

/**
 * Build a dup-key predicate for the given repository. Prefers the kit's
 * own `isDuplicateKeyError` (it knows its driver — Mongo `11000`, Prisma
 * `P2002`, Postgres `23505`, MySQL `1062`, etc.); falls back to a
 * conservative Mongo check so mongokit ≤3.8 keeps working without changes.
 *
 * Non-mongo kits MUST implement the predicate to participate in
 * idempotency/outbox dup-handling semantics.
 *
 * `name === "MongoServerError"` alone is deliberately NOT matched — that
 * also fires on WriteConflict / NotWritablePrimary / transient failures,
 * which must propagate rather than silently become 409s.
 */
export function createIsDuplicateKeyError(repository: RepositoryLike): (err: unknown) => boolean {
  const repoPredicate =
    typeof repository.isDuplicateKeyError === "function"
      ? repository.isDuplicateKeyError.bind(repository)
      : null;
  return (err: unknown): boolean => {
    if (repoPredicate) return repoPredicate(err);
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: number; codeName?: string };
    return e.code === 11000 || e.codeName === "DuplicateKey";
  };
}
