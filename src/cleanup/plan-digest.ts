/**
 * Deterministic integrity checksums for plans + manifests.
 *
 * The operator previews a plan, then confirms by echoing its digest. At execute
 * time the server RE-PLANS and compares digests: if the world changed between
 * preview and confirm (more rows, a new blocker), the digest differs and the
 * run is refused with `CLEANUP_PLAN_CHANGED` (§7 "Execute"). So the digest MUST
 * be a stable function of the plan's MATERIAL content only — invariant to
 * object key order, and excluding volatile/advisory fields.
 *
 * These are integrity CHECKSUMS (accidental-corruption + drift detection), NOT
 * tamper-proof seals: plain SHA-256 does not stop an actor with write access
 * from replacing a record and recomputing its digest. Pair with access control
 * / keyed signatures where that matters.
 *
 * The canonicalizer + hash are the shared `@classytic/primitives/canonical`
 * implementation (`Date`-explicit, strict-reject of `undefined`/`NaN`/`BigInt`/
 * `function`/`symbol`/`Map`/`Set`/cyclic). Two domains consume it — cleanup
 * manifests here + financial-close evidence manifests in arc-accounting — so it
 * lives in primitives, not duplicated per package. `canonicalJson` is re-exported
 * for existing importers; peer floor `@classytic/primitives >= 0.17.0`.
 */

import { canonicalJson, sha256Hex } from "@classytic/primitives/canonical";
import type { CleanupPlan } from "./types.js";

export { canonicalJson };

/**
 * The material content of a plan — everything an operator is consenting to.
 * Deliberately EXCLUDES `digest` (self-reference) and advisory `warnings`.
 */
function planMaterial(plan: Omit<CleanupPlan, "digest">): Record<string, unknown> {
  return {
    recipeId: plan.recipeId,
    parameters: plan.parameters,
    // Sort items by resource so the digest is a function of the item SET, not
    // the recipe's incidental display order — the operator consents to
    // "these resources with these estimates", however they're listed.
    items: plan.items
      .map((i) => ({
        resource: i.resource,
        estimated: i.estimated,
        retained: i.retained ?? null,
        blockers: [...(i.blockers ?? [])].sort(),
      }))
      .sort((a, b) =>
        a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : a.estimated - b.estimated,
      ),
    retains: [...plan.retains].sort(),
    blockers: [...plan.blockers].sort(),
    rebuildActions: [...plan.rebuildActions].sort(),
    // warnings are advisory, NOT part of consent — excluded from the digest.
    estimatedTotal: plan.estimatedTotal,
    confirmationPhrase: plan.confirmationPhrase,
  };
}

/** `sha256(canonical(planMaterial))` as a hex digest. */
export function computePlanDigest(plan: Omit<CleanupPlan, "digest">): string {
  return sha256Hex(canonicalJson(planMaterial(plan)));
}

/**
 * Integrity checksum of a completed manifest (§5). Excludes the digest field
 * itself. Dates (e.g. `completedAt`) participate via the strict canonicalizer.
 */
export function computeManifestDigest(manifest: Record<string, unknown>): string {
  const { manifestDigest: _drop, ...rest } = manifest;
  return sha256Hex(canonicalJson(rest));
}
