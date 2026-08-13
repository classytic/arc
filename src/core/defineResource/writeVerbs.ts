/**
 * Phase 4b — write-verb registration policy.
 *
 * A declared command that never executes is the defect `writes` exists to
 * close, one layer up: the resource READS as though the kernel's guarded verb
 * owns the slot while generic CRUD serves the route. So reachability is
 * enforced at REGISTRATION, fail-loud (same posture as `threadQueryParser`):
 *
 *   1. the controller must DISPATCH `_writes` — proven by a prototype
 *      capability mark, not by a duck-typed `configure()`, which shows an
 *      options channel exists and not that anything reads `writes` from it;
 *   2. no declared verb's slot may be OVERRIDDEN — route dispatch calls the
 *      override, so the verb behind it is dead code. Holds even for overrides
 *      that delegate to `super`: unprovable statically, so the combination is
 *      forbidden. Wrap behaviour with `hooks` instead.
 *
 * Config-SHAPE validation (unknown keys, non-function entries, disabled slots)
 * needs no controller and lives in `validateResourceConfig`.
 */

import { MUTATION_OPERATIONS } from "../../constants.js";
import { arcLog } from "../../logger/index.js";
import type { AnyRecord } from "../../types/index.js";
import type { ResourceWrites, WriteVerbKey } from "../../types/resource/writes.js";
import { detectOverriddenWriteSlots, isWriteVerbCapable } from "../crud/requestPipeline.js";
import type { InternalResourceConfig } from "./config.js";

/**
 * The write slots, as a runtime list. `MUTATION_OPERATIONS` is the canonical
 * constant; `satisfies` pins it to the `WriteVerbKey` type so the two cannot
 * drift without a compile error.
 */
const WRITE_VERBS = MUTATION_OPERATIONS satisfies readonly WriteVerbKey[];

/** The verbs a resource actually declared (function-valued entries only). */
function declaredWriteVerbs(writes: ResourceWrites | undefined): WriteVerbKey[] {
  if (!writes) return [];
  return WRITE_VERBS.filter((op) => typeof (writes as Record<string, unknown>)[op] === "function");
}

/**
 * Boot-fatal reachability check for declared write verbs on a HOST-SUPPLIED
 * controller. Auto-built controllers never call this — they are capable and
 * un-overridden by construction.
 *
 * Throws before any option threading, so a rejected resource has no partial
 * side effects to reason about.
 */
export function enforceWriteVerbReachability<TDoc extends AnyRecord>(
  controller: unknown,
  resolvedConfig: InternalResourceConfig<TDoc>,
): void {
  const declared = declaredWriteVerbs(resolvedConfig.writes as ResourceWrites | undefined);
  if (declared.length === 0) return;

  if (typeof controller !== "object" || controller === null || !isWriteVerbCapable(controller)) {
    throw new Error(
      `Resource "${resolvedConfig.name}" declares write verb(s) [${declared.join(", ")}] but its ` +
        "controller is not built on arc's write pipeline, so the verbs would be silently " +
        "dropped and generic CRUD would serve those routes — the exact bypass `writes` exists " +
        "to close. Extend `BaseController` / `BaseCrudController` (their write methods dispatch " +
        "declared verbs), or omit `controller` and let arc auto-build one, or move the commands " +
        "into the controller itself and remove `writes`.",
    );
  }

  const collisions = detectOverriddenWriteSlots(controller, declared);
  if (collisions.length > 0) {
    throw new Error(
      `Resource "${resolvedConfig.name}" declares write verb(s) [${collisions.join(", ")}] AND ` +
        "overrides the controller method(s) for the same slot(s). Route dispatch calls the " +
        "override, so the declared verb can never execute — it is dead code that reads as if " +
        "it guards the route. Keep exactly one owner per slot: remove the override and let the " +
        "verb own persistence (wrap request-level behaviour with `hooks` — before/around/after " +
        "run around the verb), or remove the `writes` entry and let the override own the whole " +
        "pipeline.",
    );
  }
}

/**
 * Warn when a controller OVERRIDES a write method while the resource declares
 * field rules only arc's pipeline enforces.
 *
 * Measured: a resource with eight `systemManaged` fields overrode `update` to
 * reach its kernel's guarded verb; `PATCH` then wrote `status: "posted"` and a
 * forged `number` straight through, answering 200. The override was added to
 * close one hole and opened a wider one.
 *
 * Scoped so it stays worth reading: write-verb-capable controllers only,
 * BODY-BEARING ops only (`delete` carries no body for the sanitizer), and only
 * when protection is actually declared. A slot WITH a verb never reaches here —
 * `enforceWriteVerbReachability` already threw.
 */
export function warnOnWriteMethodOverride<TDoc extends AnyRecord>(
  controller: unknown,
  resolvedConfig: InternalResourceConfig<TDoc>,
): void {
  if (typeof controller !== "object" || controller === null || !isWriteVerbCapable(controller)) {
    return;
  }

  const fieldRules = resolvedConfig.schemaOptions?.fieldRules;
  const protectedFields = fieldRules ? Object.keys(fieldRules) : [];
  const hasFieldPermissions =
    resolvedConfig.fields !== undefined && Object.keys(resolvedConfig.fields).length > 0;
  if (protectedFields.length === 0 && !hasFieldPermissions) return;

  // Body-bearing ops only — `delete` has no body for the sanitizer to check.
  const overridden = detectOverriddenWriteSlots(controller, ["create", "update"] as const);
  if (overridden.length === 0) return;

  arcLog("defineResource").warn(
    `Resource "${resolvedConfig.name}" overrides controller method(s) ` +
      `[${overridden.join(", ")}] AND declares field protection ` +
      `(${protectedFields.length > 0 ? `fieldRules: ${protectedFields.join(", ")}` : "fields"}). ` +
      "An override replaces arc's entire write pipeline — body sanitization against those " +
      "field rules, tenant injection, createdBy/updatedBy stamping and the before/around/after " +
      "hooks all stop running for that op, so the declared protection is NOT enforced. " +
      "If the override exists to reach a domain command, declare it as a write verb instead " +
      "(`writes: { " +
      `${overridden[0]}: (…) => engine.<verb>(…) } ` +
      "`) — arc keeps the pipeline and calls your command in place of the repository. " +
      "If the override genuinely needs to replace the pipeline, call " +
      "`this.bodySanitizer.sanitize(body, op, req, ctx)` inside it.",
  );
}
