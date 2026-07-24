/**
 * Deterministic plan digest — the tamper-evidence seal on a cleanup plan.
 *
 * The operator previews a plan, then confirms by echoing its digest. At
 * execute time the server RE-PLANS and compares digests: if the world changed
 * between preview and confirm (more rows, a new blocker), the digest differs
 * and the run is refused with `CLEANUP_PLAN_CHANGED` (design §7 "Execute"). So
 * the digest MUST be a stable function of the plan's MATERIAL content only —
 * invariant to object key order, and excluding volatile fields (timestamps).
 */

import { createHash } from "node:crypto";
import type { CleanupPlan } from "./types.js";

/** Deterministic JSON: object keys sorted recursively; arrays keep order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * The material content of a plan — everything an operator is consenting to.
 * Deliberately EXCLUDES `digest` (self-reference) and any volatile field.
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
      .sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : a.estimated - b.estimated)),
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
  return createHash("sha256").update(stableStringify(planMaterial(plan))).digest("hex");
}

/**
 * Canonical digest of a completed manifest (design §5 "Canonicalize and hash
 * the manifest"). Excludes the digest field itself.
 */
export function computeManifestDigest(manifest: Record<string, unknown>): string {
  const { manifestDigest: _drop, ...rest } = manifest;
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}
