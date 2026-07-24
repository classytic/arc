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
 * The canonicalizer is STRICT JSON-compatible: `Date` → a tagged ISO string,
 * finite numbers only, and unsupported values (`undefined`, `NaN`/`Infinity`,
 * `BigInt`, `function`, `symbol`, `Map`, `Set`, cyclic refs) are REJECTED rather
 * than silently hashed as `{}` (the bug a plain `JSON`-shaped stringify hides).
 */

import { createHash } from "node:crypto";
import type { CleanupPlan } from "./types.js";

class CanonicalizeError extends Error {
  constructor(message: string) {
    super(`cleanup canonicalize: ${message}`);
    this.name = "CanonicalizeError";
  }
}

/**
 * Deterministic, strict canonical string. Object keys sorted recursively;
 * arrays keep order; `Date` is serialized explicitly so timestamps participate
 * in the digest; unsupported/ambiguous values throw.
 */
function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new CanonicalizeError(`non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (t === "undefined") throw new CanonicalizeError("undefined is not serializable");
  if (t === "bigint") throw new CanonicalizeError("bigint is not serializable");
  if (t === "function" || t === "symbol") throw new CanonicalizeError(`${t} is not serializable`);

  // Objects
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) throw new CanonicalizeError("invalid Date");
    return `{"$date":${JSON.stringify(value.toISOString())}}`;
  }
  if (value instanceof Map || value instanceof Set) {
    throw new CanonicalizeError(
      `${value.constructor.name} is not supported — use a plain object/array`,
    );
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalizeError("cyclic reference");
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => canonicalize(v, seen)).join(",")}]`;
    }
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k], seen)}`).join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Strict canonical JSON of any value (throws on unsupported input). */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet());
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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
  return sha256(canonicalJson(planMaterial(plan)));
}

/**
 * Integrity checksum of a completed manifest (§5). Excludes the digest field
 * itself. Dates (e.g. `completedAt`) participate via the strict canonicalizer.
 */
export function computeManifestDigest(manifest: Record<string, unknown>): string {
  const { manifestDigest: _drop, ...rest } = manifest;
  return sha256(canonicalJson(rest));
}
