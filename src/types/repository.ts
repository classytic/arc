/**
 * Repository types — arc-owned additions only.
 *
 * The cross-kit repository contract lives in `@classytic/repo-core`. Arc
 * does not re-export it. Import repo-core types directly from the package
 * you already depend on:
 *
 * ```ts
 * import type { StandardRepo, WriteOptions, QueryOptions } from '@classytic/repo-core/repository';
 * import type { OffsetPaginationResult, KeysetPaginationResult } from '@classytic/repo-core/pagination';
 * ```
 *
 * This file only defines types arc **owns** — structural compositions and
 * discriminated unions that aren't in repo-core.
 */

import type {
  KeysetPaginationResult,
  OffsetPaginationResult,
} from "@classytic/repo-core/pagination";

/**
 * Discriminated union of pagination result shapes. Narrow on `method`.
 *
 * repo-core ships the individual shapes (`OffsetPaginationResult` /
 * `KeysetPaginationResult`) but no combined union — arc needs one for the
 * BaseController's `list` / `getDeleted` return signatures, where either
 * shape is valid depending on the caller's pagination params.
 *
 * @example
 * ```ts
 * const result = await repo.getAll(params);
 * if (result.method === 'keyset') {
 *   result.next;     // keyset cursor
 * } else {
 *   result.page;     // offset number
 * }
 * ```
 */
export type PaginationResult<TDoc, TExtra extends Record<string, unknown> = Record<string, never>> =
  | OffsetPaginationResult<TDoc, TExtra>
  | KeysetPaginationResult<TDoc, TExtra>;
