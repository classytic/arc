/**
 * `defineErrorMapper<T>()` — typed helper for registering `ErrorMapper`s in
 * the `errorMappers` array of `errorHandlerPlugin` without a cast.
 *
 * **Why this exists (v2.10.6):** `ErrorMapper<T>` types `toResponse(err: T)`
 * — a contravariant position. When you put `ErrorMapper<FlowError>` into an
 * `ErrorMapper[]` (which defaults to `ErrorMapper<Error>`), TS refuses the
 * assignment because `(err: Error) => X` is NOT assignable to
 * `(err: FlowError) => X`. Consumers had to write
 * `as unknown as ErrorMapper` at every registration site.
 *
 * This helper encapsulates that cast exactly once, inside arc, with a
 * documented runtime invariant: the dispatch is `instanceof`-based, so the
 * `toResponse` callback is always invoked with an instance of `T` and the
 * widened type in the array is sound.
 *
 * @example
 * ```ts
 * import { defineErrorMapper } from '@classytic/arc/utils';
 *
 * class FlowError extends Error {
 *   constructor(message: string, public readonly code: string) { super(message); }
 * }
 *
 * errorHandler: {
 *   errorMappers: [
 *     defineErrorMapper<FlowError>({
 *       type: FlowError,
 *       toResponse: (err) => ({ status: 400, code: err.code, message: err.message }),
 *     }),
 *   ],
 * }
 * ```
 */

import type { ErrorMapper } from "../plugins/errorHandler.js";

/**
 * Register an `ErrorMapper` with its domain-specific generic argument and
 * have it assign cleanly into `ErrorMapper[]` (no `as unknown as ErrorMapper`).
 *
 * The returned mapper is identical at runtime — `type` and `toResponse` are
 * passed through untouched. Only the declared type widens from
 * `ErrorMapper<T>` to `ErrorMapper` so the array inference works.
 *
 * Safety: the `errorHandlerPlugin` dispatches via `error instanceof mapper.type`
 * before invoking `toResponse`, so the widened callback signature is never
 * called with a non-`T` error at runtime. This helper codifies that invariant
 * in one place.
 */
export function defineErrorMapper<T extends Error>(mapper: ErrorMapper<T>): ErrorMapper {
  return mapper as unknown as ErrorMapper;
}
