/**
 * Internal config types — phase-extension shape that `defineResource()`
 * passes between phases.
 *
 * The public {@link ResourceConfig} is the user-authored shape. Phases
 * 3 (`applyPresetsAndAutoInject`) and 4 (`resolveOrAutoCreateController`)
 * stamp internal metadata onto the config (`_appliedPresets`,
 * `_controllerOptions`, raw `_hooks` from presets) — kept on the same
 * object instead of a parallel struct so each phase reads one pristine
 * source of truth.
 *
 * Earlier revisions split this into two near-duplicate types
 * (`ExtendedResourceConfig` + `ResolvedResourceConfig`) tracking
 * "preset-collected" vs "wired-onto-resource" hook arrays. Collapsed
 * into a single type because (a) `ResourceDefinition`'s constructor
 * never actually reads `_pendingHooks` from config — it defaults to
 * `[]` and `wireHooks` pushes onto the instance directly; (b) the
 * duplicate added a maintenance tax with no payoff.
 */

import type { AnyRecord, ResourceConfig } from "../../types/index.js";

/**
 * One row in the preset-collected hook array. Presets emit these
 * during `applyPresets()`; `wireHooks` projects them onto the
 * resource's `_pendingHooks` (with `priority` defaulted to 10).
 */
export interface PresetHook {
  presetName: string;
  operation: "create" | "update" | "delete" | "read" | "list";
  phase: "before" | "after";
  handler: (ctx: AnyRecord) => unknown;
  priority?: number;
}

/**
 * Phase metadata stamped onto the user's `ResourceConfig` during the
 * `defineResource()` pipeline. Every field is optional — phases that
 * don't run (no presets, custom controller, etc.) leave the slots
 * untouched.
 */
export interface InternalConfigExtras {
  /** Names of presets that ran (for introspection / registry metadata). */
  _appliedPresets?: string[];
  /**
   * Controller-construction options collected from presets
   * (slugLookup → `slugField`, parent → `parentField`, etc.).
   * Threaded into auto-built `BaseController` via the `presetFields`
   * arg; warned-on for user-supplied controllers (see
   * `resolveOrAutoCreateController`).
   */
  _controllerOptions?: {
    slugField?: string;
    parentField?: string;
    [key: string]: unknown;
  };
  /** Raw preset-collected hooks (pre-wiring). Consumed by `wireHooks`. */
  _hooks?: PresetHook[];
}

/**
 * The full internal shape — `ResourceConfig` + the phase metadata.
 * This is what flows from Phase 3 onward; phases mutate fields on a
 * fresh clone (never the caller's reference — `applyPresetsAndAutoInject`
 * always spreads).
 */
export type InternalResourceConfig<TDoc = AnyRecord> = ResourceConfig<TDoc> & InternalConfigExtras;
