/**
 * `simpleEqualityMatcher` — a minimal, dialect-agnostic flat-key equality
 * matcher for `DataAdapter.matchesFilter` / `BaseController({ matchesFilter })`.
 *
 * **What it does:** for each `[key, expected]` in the filter, compares
 * `item[key]` to `expected` via string coercion (so Mongo `ObjectId` values
 * match their string representation) and returns `true` only if every
 * filter entry matches. Array item values are matched implicitly (contains).
 *
 * **What it does NOT do:**
 * - No `$eq` / `$ne` / `$in` / `$nin` / `$gt` / `$lt` / `$regex` / `$exists`
 * - No `$and` / `$or`
 * - No dot-path traversal (`"owner.id"`)
 * - No schema-specific coercion
 *
 * **Why it exists:** 95%+ of arc's `_policyFilters` are produced by built-in
 * permission helpers and are shaped like `{ ownerId: "u1" }` or
 * `{ organizationId: "org_x" }` — flat equality. For that common shape,
 * this helper is a safe, tested, 15-line defense-in-depth matcher that
 * hosts using minimal repos (no `getOne(compoundFilter)` DB path) can opt
 * into without arc shipping a full Mongo-syntax engine.
 *
 * **When to use:**
 * - Your adapter/repo doesn't natively filter on `getOne(compoundFilter)`
 * - Your `_policyFilters` are flat equality (from arc's built-in permission helpers)
 * - You want defense-in-depth on `validateItemAccess` / `fetchDetailed`'s `getById` fallback
 *
 * **When NOT to use:**
 * - Your `_policyFilters` use operators (`$in`, `$ne`, etc.) — supply a
 *   native matcher (mongokit's repo does the filter at the DB layer; for
 *   custom repos, wrap the kit's own predicate engine).
 * - You're a mongokit / sqlitekit / Prisma user — the DB-level filter
 *   applied by `getOne(compoundFilter)` already covers this.
 *
 * @example
 * ```ts
 * import { simpleEqualityMatcher } from '@classytic/arc/utils';
 *
 * // On a custom adapter
 * const adapter: DataAdapter = {
 *   repository,
 *   type: 'custom',
 *   name: 'in-memory',
 *   matchesFilter: simpleEqualityMatcher,
 * };
 *
 * // Or directly on BaseController for ad-hoc controllers
 * new BaseController(repo, { matchesFilter: simpleEqualityMatcher });
 * ```
 */
export function simpleEqualityMatcher(item: unknown, filters: Record<string, unknown>): boolean {
  if (!item || typeof item !== "object") return false;
  const obj = item as Record<string, unknown>;

  for (const [key, expected] of Object.entries(filters)) {
    // Operator-shaped filter values aren't supported by this helper.
    // Detect via "plain object with $-prefixed keys" — this lets class
    // instances (ObjectId, Date, custom value types) fall through to the
    // string-coercion equality check below, while `{ $in: [...] }` /
    // `{ $ne: x }` / etc. are rejected conservatively.
    //
    // Hosts that use operators must supply an adapter matcher that
    // understands their dialect — see the jsdoc above.
    if (
      expected &&
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      Object.getPrototypeOf(expected) === Object.prototype &&
      Object.keys(expected).some((k) => k.startsWith("$"))
    ) {
      // Reject: operator filter without an adapter matcher.
      return false;
    }

    const actual = obj[key];

    // Implicit array matching: `{ tags: "hot" }` matches `{ tags: ["hot", "new"] }`.
    if (Array.isArray(actual)) {
      const expectedStr = String(expected);
      if (!actual.some((v) => String(v) === expectedStr)) return false;
      continue;
    }

    // String coercion for ObjectId compatibility — Mongo ObjectIds only
    // `===` by reference, but string representations compare by value.
    if (String(actual) !== String(expected)) return false;
  }

  return true;
}
