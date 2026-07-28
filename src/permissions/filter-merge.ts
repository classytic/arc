/**
 * Policy-filter composition — logical AND, never last-writer-wins.
 *
 * Row-level policy filters can arrive from several INDEPENDENT sources for one
 * request: a tenant preset, an `ownedByUser` grant, an `allOf(...)` branch, a
 * host permission check. Every one of them is a RESTRICTION the row must
 * satisfy, so composing them is logical AND.
 *
 * The historical `{ ...base, ...incoming }` shallow spread did NOT implement AND:
 * when two sources constrained the SAME key with different values, the later one
 * silently REPLACED the earlier one — widening (or erasing) a restriction another
 * layer deliberately imposed. That is a defense-in-depth defect, not a
 * refinement. "Later can refine" is only sound when the refinement is provably
 * narrower, and a bare overwrite proves nothing.
 *
 * {@link conjoinPolicyFilters} composes with AND semantics while preserving the
 * common case byte-for-byte:
 *
 *  - key present on only one side      → carried through flat. Non-overlapping
 *    filters (the ~99% case) produce exactly the same object the old spread did,
 *    so there is ZERO behavior change for them.
 *  - same key, deep-equal value        → kept once (idempotent — e.g. two checks
 *    both pinning the same `organizationId`).
 *  - same key, DIFFERENT value         → BOTH constraints are preserved under an
 *    `$and`, so a row must satisfy both. For flat equality that conjunction is
 *    unsatisfiable, so the query returns nothing — the safe, correct outcome for
 *    contradictory policies (deny), and the earlier restriction is never dropped.
 *
 * Adapter safety: mongokit / sqlitekit compile `$and` natively at the DB layer,
 * and arc's in-memory `simpleEqualityMatcher` (AccessControl.checkPolicyFilters)
 * already fail-closes on operator-shaped filters. So a produced `$and` is either
 * evaluated correctly by the DB or rejected fail-closed in memory — both safe.
 *
 * This is the pragmatic, adapter-neutral form of the AND semantics. A canonical
 * filter IR in `repo-core` (nested and/or/not nodes each adapter compiles) is the
 * fuller design, but this closes the security defect without one.
 */

/**
 * Validate + return a `$and` operand's fragment array. A security-policy
 * normalizer must NEVER silently drop a malformed constraint — a non-array
 * `$and` (e.g. `{ $and: { organizationId: "a" } }`) is a policy bug, so fail
 * loud (fail-closed) rather than discard the restriction it was meant to carry.
 */
function coercePolicyAnd(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `conjoinPolicyFilters: malformed '$and' — expected an array of filter fragments, got ${
        value === null ? "null" : typeof value
      }. A policy filter constraint must not be silently dropped.`,
    );
  }
  return value as Record<string, unknown>[];
}

/** Are two flat policy-filter values equivalent for conjunction purposes? */
function filterValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Operator objects (`{ $in: [...] }`) etc.: a stable structural compare.
  // A false negative only costs a redundant (still-correct) `$and` entry, so
  // erring toward "not equal" is safe.
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Conjoin two policy-filter maps with AND semantics. Never silently overwrites a
 * same-key constraint with a different value — conflicting keys are preserved
 * under `$and`. See the module doc for the full contract.
 */
export function conjoinPolicyFilters(
  base: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const baseEmpty = !base || Object.keys(base).length === 0;
  const incomingEmpty = !incoming || Object.keys(incoming).length === 0;
  if (baseEmpty) return incomingEmpty ? {} : { ...incoming };
  if (incomingEmpty) return { ...base };

  const result: Record<string, unknown> = {};
  // Carry forward any `$and` fragments already accumulated on either side so a
  // three-way conjoin (a, then b, then c) stays a single flat conjunction.
  const andParts: Record<string, unknown>[] = [];
  const baseAnd = (base as Record<string, unknown>).$and;
  if (baseAnd !== undefined) andParts.push(...coercePolicyAnd(baseAnd));

  for (const [key, value] of Object.entries(base as Record<string, unknown>)) {
    if (key === "$and") continue;
    result[key] = value;
  }

  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (key === "$and") {
      andParts.push(...coercePolicyAnd(value));
      continue;
    }
    if (!(key in result)) {
      result[key] = value;
      continue;
    }
    if (filterValueEqual(result[key], value)) continue; // idempotent — keep once
    // Genuine conflict: preserve BOTH restrictions under `$and`, drop the flat key.
    andParts.push({ [key]: result[key] }, { [key]: value });
    delete result[key];
  }

  if (andParts.length > 0) result.$and = andParts;
  return result;
}
