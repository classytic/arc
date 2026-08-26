/**
 * `simpleEqualityMatcher` — a minimal, dialect-agnostic flat-key equality
 * matcher for `DataAdapter.matchesFilter` / `BaseController({ matchesFilter })`.
 *
 * Compares `item[key]` to each filter value by string coercion, so a Mongo
 * `ObjectId` matches its string form; array values match by contains. ALL
 * entries must match.
 *
 * NOT an operator engine: no `$in`/`$ne`/`$gt`/`$regex`/`$exists`, no
 * `$and`/`$or`, no dot paths, no schema coercion. Most `_policyFilters` from
 * arc's built-in permission helpers are flat equality (`{ ownerId }`,
 * `{ organizationId }`), and this covers exactly that — defense-in-depth for
 * hosts on minimal repos with no `getOne(compoundFilter)` path.
 *
 * Do NOT use it with operator-shaped filters — supply a native matcher instead
 * (a kit's predicate engine). Kit users need neither: the DB-level filter in
 * `getOne(compoundFilter)` already applies.
 *
 * @example
 * ```ts
 * const adapter: DataAdapter = { repository, type: 'custom', name: 'in-memory',
 *                                matchesFilter: simpleEqualityMatcher };
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
