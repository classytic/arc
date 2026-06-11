/**
 * Phase 0 — resource-level shorthand normalization.
 *
 * Expands every config shorthand into the canonical shape BEFORE
 * validation / CRUD-list resolution so every later phase observes the
 * resolved form. Each expansion is a small pure function; the
 * coordinator runs them in a fixed order because later expansions may
 * read fields earlier ones set:
 *
 *   1. expandReferenceData   — `referenceData: true` → crud / limits / cache
 *   2. expandCustomRoutesOnly — `customRoutesOnly: true` → the three skip flags
 *   3. resolveCrudAllowList  — 2.16 `crud:` allow-list → disabledRoutes /
 *                              disableDefaultRoutes
 *
 * Explicit narrow settings always win over shorthands. Pure
 * transformation — the caller's `config` is never mutated; the rest of
 * the pipeline reads the normalised copy.
 */

import type { ResourceConfig } from "../../types/index.js";

/**
 * Run all Phase-0 expansions in order and return the canonical config.
 *
 * The `crud:` allow-list resolves LAST and is lifted BEFORE validation
 * so the validator sees the resolved shape: `crud: false` looks like
 * `disableDefaultRoutes: true` (no adapter required) instead of "CRUD
 * enabled but no adapter" (a confusing false-positive error).
 */
export function normalizeResourceConfig<TDoc>(config: ResourceConfig<TDoc>): ResourceConfig<TDoc> {
  const referenceExpanded = expandReferenceData(config);
  const shorthandConfig = expandCustomRoutesOnly(referenceExpanded);
  return resolveCrudAllowList(shorthandConfig);
}

/**
 * Expand the `referenceData: true` shorthand. Reference data is the
 * recurring "small static catalogue" shape (currencies, plans,
 * pipeline stages, credential types) where callers want "fetch all"
 * semantics and aggressive caching — pre-2.17.0 hosts hand-wired
 * `crud` + `defaultLimit` + `maxLimit` + `cache` on every such
 * resource. The shorthand pins canonical defaults; explicit narrow
 * settings always win so a host can opt INTO mutations
 * (`referenceData: true, crud: { list: true, get: true, create: true }`)
 * or override the cache window without giving up the read-only +
 * fetch-all defaults.
 */
function expandReferenceData<TDoc>(config: ResourceConfig<TDoc>): ResourceConfig<TDoc> {
  if (config.referenceData !== true) return config;
  return {
    ...config,
    // Read-only by default — reference data is mutated via migrations /
    // admin tooling, not the public REST surface. Hosts that want
    // mutations declare `crud` explicitly.
    crud: config.crud ?? { list: true, get: true },
    defaultLimit: config.defaultLimit ?? 1000,
    maxLimit: config.maxLimit ?? 1000,
    // Reference data is mostly static — 5 min fresh, 10 min GC window.
    // Values are SECONDS per `ResourceCacheConfig`; no-op when
    // `queryCachePlugin` isn't registered (first-mount diagnostic fires
    // — same contract as a hand-written `cache:` block).
    cache: config.cache ?? { staleTime: 300, gcTime: 600 },
  };
}

/**
 * Expand the `customRoutesOnly: true` shorthand into its three primitive
 * flags. The shorthand exists because hosts wiring a "service resource"
 * (custom routes only, no adapter, no auto-CRUD) had to remember to set
 * `disableDefaultRoutes` + `skipValidation` + `skipRegistry` in lockstep —
 * forgetting any one of them produced confusing errors ("controller
 * required when CRUD routes are enabled" for a resource that ships none).
 *
 * Explicit narrow settings always win — the shorthand only fills in
 * flags that were not set so power users can opt back into a specific
 * primitive (`customRoutesOnly: true, skipRegistry: false` keeps OpenAPI
 * docs while still skipping CRUD + validation).
 */
function expandCustomRoutesOnly<TDoc>(config: ResourceConfig<TDoc>): ResourceConfig<TDoc> {
  if (config.customRoutesOnly !== true) return config;
  return {
    ...config,
    customRoutesOnly: undefined,
    disableDefaultRoutes: config.disableDefaultRoutes ?? true,
    skipValidation: config.skipValidation ?? true,
    skipRegistry: config.skipRegistry ?? true,
  };
}

/**
 * Normalise the 2.16 `crud:` positive-form allow-list into the canonical
 * `{ disabledRoutes, disableDefaultRoutes }` pair the rest of arc reads.
 *
 * Three input forms collapse to one output:
 *   - `crud: false`           → `disableDefaultRoutes: true`
 *   - `crud: { list: true }`  → `disabledRoutes: [get,create,update,delete]`
 *   - legacy `disabledRoutes` → passed through unchanged
 *
 * Mutually exclusive: `crud` + `disabledRoutes` together is a config bug
 * (the host meant ONE of two intents) — throw rather than pick.
 *
 * Lifted out of the `ResourceDefinition` constructor in 2.16 so the
 * validator (Phase 1) observes the post-resolve shape — `crud: false`
 * now looks like `disableDefaultRoutes: true` to the validator, so it
 * doesn't false-positive "Data adapter required when CRUD routes are
 * enabled" on a host that explicitly opted CRUD out.
 */
function resolveCrudAllowList<TDoc>(config: ResourceConfig<TDoc>): ResourceConfig<TDoc> {
  const { crud, disabledRoutes: legacyDisabled, disableDefaultRoutes: legacyDisableAll } = config;
  if (crud === undefined) return config;

  if (legacyDisabled !== undefined) {
    throw new Error(
      `[Arc] Resource '${config.name}': pass either \`crud\` (positive allow-list) ` +
        "or `disabledRoutes` (negative opt-out), not both. The positive form is " +
        "the documented default going forward; drop `disabledRoutes` when both are set.",
    );
  }

  if (crud === false) {
    return { ...config, crud: undefined, disableDefaultRoutes: true };
  }

  // `crud: { list: true, ... }` — push every op NOT explicitly enabled
  // into `disabledRoutes`. The four-CRUD list is hardcoded here (same
  // shape `CRUD_OPERATIONS` exposes) to avoid pulling that import into
  // the orchestrator's pipeline.
  const allowedOps: ReadonlyArray<"list" | "get" | "create" | "update" | "delete"> = [
    "list",
    "get",
    "create",
    "update",
    "delete",
  ];
  const disabled = allowedOps.filter((op) => crud[op] !== true);
  return {
    ...config,
    crud: undefined,
    disabledRoutes: disabled,
    disableDefaultRoutes: legacyDisableAll ?? false,
  };
}
