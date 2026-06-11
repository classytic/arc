/**
 * Resource-dispatch verbs (`?_count` / `?_distinct` / `?_exists`) —
 * pure verb matching + repo executors extracted from `BaseCrudController`.
 *
 * `_count` / `_distinct` / `_exists` route to repo.count() /
 * repo.distinct() / repo.exists() respectively, NOT getAll().
 * Same `list` permission gate, same tenant + policy filter scope,
 * smaller response payload. Reserved-key set lives in repo-core's
 * `STANDARD_RESERVED_PARAMS` (kits skip them at filter parse time
 * so `?_count=true&status=active` filters by status).
 *
 * Each executor takes a `resolveScope` thunk instead of pre-resolved
 * filter/options so the capability check (`501` when the adapter lacks
 * the repo method) runs BEFORE query resolution — preserving the
 * controller's original error precedence (a missing adapter method wins
 * over a malformed query).
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { AnyRecord } from "../../types/index.js";
import { createError } from "../../utils/errors.js";
import { withRepoFeatures } from "../../utils/repoFeature.js";

/** Filter + tenant/audit options resolved by the controller for a verb. */
export interface DispatchScope {
  filter: AnyRecord;
  options: AnyRecord;
}

const isTruthyFlag = (value: unknown): boolean =>
  value !== undefined && value !== "" && value !== "false" && value !== false;

/**
 * Match a request query against the resource-dispatch verbs. Returns
 * `null` when the request is a regular list query.
 *
 * Verbs (mutually exclusive — first match wins):
 *   - `?_count=true` → `{ kind: 'count' }`
 *   - `?_distinct=field` → `{ kind: 'distinct', field }`
 *   - `?_exists=true` → `{ kind: 'exists' }`
 */
export function matchResourceVerb(
  query: Record<string, unknown> | undefined,
): { kind: "count" } | { kind: "distinct"; field: string } | { kind: "exists" } | null {
  if (!query) return null;

  if (isTruthyFlag(query._count)) return { kind: "count" };

  const distinctField = query._distinct;
  if (typeof distinctField === "string" && distinctField.length > 0) {
    return { kind: "distinct", field: distinctField };
  }

  if (isTruthyFlag(query._exists)) return { kind: "exists" };

  return null;
}

/**
 * Normalizes `repo.exists()` return shapes across adapters. Per
 * StandardRepo's contract, `exists` may return `boolean`, `{ _id }`,
 * or `null` — every truthy non-null shape collapses to `true`.
 */
export function isExistsResultTruthy(result: unknown): boolean {
  return result !== null && result !== false && result !== undefined;
}

/** `?_count=true` → `repo.count(filter)` */
export async function runCountVerb(
  repository: RepositoryLike,
  resolveScope: () => DispatchScope,
): Promise<{ count: number }> {
  const repo = withRepoFeatures<{
    count?: (f: AnyRecord, o: AnyRecord) => Promise<number>;
  }>(repository);
  if (typeof repo.count !== "function") {
    throw createError(
      501,
      "_count is not supported: the resource's storage adapter does not implement repo.count()",
    );
  }
  const { filter, options } = resolveScope();
  const count = (await repo.count(filter, options)) as number;
  return { count };
}

/** `?_distinct=field` → `repo.distinct(field, filter)` */
export async function runDistinctVerb(
  repository: RepositoryLike,
  field: string,
  resolveScope: () => DispatchScope,
): Promise<unknown[]> {
  const repo = withRepoFeatures<{
    distinct?: (f: string, q: AnyRecord, o: AnyRecord) => Promise<unknown[]>;
  }>(repository);
  if (typeof repo.distinct !== "function") {
    throw createError(
      501,
      "_distinct is not supported: the resource's storage adapter does not implement repo.distinct()",
    );
  }
  const { filter, options } = resolveScope();
  const values = (await repo.distinct(field, filter, options)) as unknown[];
  return values;
}

/**
 * `?_exists=true` → `repo.exists(filter)`. Returns the RAW repo result —
 * the controller collapses it via its (overridable) `isExistsTruthy`
 * so subclass overrides of the truthiness rule keep working.
 */
export async function runExistsVerb(
  repository: RepositoryLike,
  resolveScope: () => DispatchScope,
): Promise<unknown> {
  const repo = withRepoFeatures<{
    exists?: (f: AnyRecord, o: AnyRecord) => Promise<unknown>;
  }>(repository);
  if (typeof repo.exists !== "function") {
    throw createError(
      501,
      "_exists is not supported: the resource's storage adapter does not implement repo.exists()",
    );
  }
  const { filter, options } = resolveScope();
  return await repo.exists(filter, options);
}
