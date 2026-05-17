/**
 * Repository feature-detection helper for arc mixins.
 *
 * Arc's `RepositoryLike` is the minimum contract every adapter
 * implements (`getById`, `getOne`, `create`, `update`, `delete`,
 * `find`). Beyond that, kits MAY expose specialized methods —
 * `createMany`, `updateMany`, `deleteMany`, `getTree`, `getBySlug`,
 * `getDeleted`, `restore`, etc. — that arc mixins detect at call
 * time and surface as 501 when missing.
 *
 * Every mixin used to spell out its own narrowing cast inline:
 *
 * ```ts
 * const repo = this.repository as unknown as {
 *   getTree?: (options?: unknown) => Promise<AnyRecord[]>;
 * };
 * ```
 *
 * Centralizing the cast keeps every feature-detection site reading
 * the same shape. The helper does not intersect with `RepositoryLike`
 * on purpose: some standard methods (`createMany`, `updateMany`) live
 * on `StandardRepo` with kit-generic signatures, and intersecting
 * would force the caller's narrowed signature to merge with the wider
 * default, producing mismatched return types. Declare every method
 * you need (base or feature) in `TFeatures`.
 *
 * @example
 * ```ts
 * const repo = withRepoFeatures<{
 *   createMany?: (items: unknown[], options?: unknown) => Promise<AnyRecord[]>;
 * }>(this.repository);
 * if (!repo.createMany) throw createError(501, "...");
 * ```
 */
export function withRepoFeatures<TFeatures>(repo: unknown): TFeatures {
  return repo as TFeatures;
}
