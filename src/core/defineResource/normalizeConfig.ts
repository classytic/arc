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
 *   3. expandHistory         — 2.22 `history: true` → audit flag + the
 *                              `GET /:id/history` route
 *   4. resolveCrudAllowList  — 2.16 `crud:` allow-list → disabledRoutes /
 *                              disableDefaultRoutes
 *
 * Explicit narrow settings always win over shorthands. Pure
 * transformation — the caller's `config` is never mutated; the rest of
 * the pipeline reads the normalised copy.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../../permissions/core.js";
import type { ResourceConfig, RouteDefinition } from "../../types/index.js";

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
  const historyExpanded = expandHistory(shorthandConfig);
  return resolveCrudAllowList(historyExpanded);
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

/** Shape of the audit decoration `expandHistory` reads at request time (structural — no runtime import of the audit plugin). */
interface AuditQuerySurface {
  query?: (options: {
    resource?: string;
    documentId?: string;
    limit?: number;
    offset?: number;
  }) => Promise<unknown[]>;
  _noop?: boolean;
}

/**
 * Expand the 2.22 `history: true` shorthand — the per-record change
 * timeline. Injects `GET /:id/history` (audit-entry page for one
 * document, newest-first per the audit store's contract) and implies
 * `audit: true` so the rows the route reads actually get written.
 *
 * The gate defaults STRICTER than reads (history exposes before/after
 * snapshots): resource `update` permission → `get` → route auth.
 * `history: { permissions }` overrides. The flag is CONSUMED here
 * (set to undefined) — later phases and the registry see only its
 * expansion, same contract as `customRoutesOnly`.
 */
function expandHistory<TDoc>(config: ResourceConfig<TDoc>): ResourceConfig<TDoc> {
  if (!config.history) return config;
  const opts = config.history === true ? {} : config.history;
  const permissions =
    opts.permissions ?? config.permissions?.update ?? config.permissions?.get ?? requireAuth();
  const defaultLimit = opts.limit ?? 50;
  const resourceName = config.name;

  const baseRoute = {
    method: "GET" as const,
    path: "/:id/history",
    summary: `Change history for a ${resourceName} record (audit-backed timeline)`,
    raw: true as const,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const audit = (request.server as unknown as { audit?: AuditQuerySurface }).audit;
      if (!audit?.query || audit._noop === true) {
        return reply.code(503).send({
          code: "history.audit_unavailable",
          message: `history for '${resourceName}' requires auditPlugin to be registered (and enabled)`,
          status: 503,
        });
      }
      const { id } = request.params as { id: string };
      const q = request.query as { limit?: string; offset?: string };
      const limit = Math.min(Number(q.limit) > 0 ? Number(q.limit) : defaultLimit, 200);
      const offset = Number(q.offset) > 0 ? Number(q.offset) : 0;
      const entries = await audit.query({ resource: resourceName, documentId: id, limit, offset });
      return reply.send({ data: entries, limit, offset });
    },
  };
  const historyRoute: RouteDefinition = { ...baseRoute, permissions };

  return {
    ...config,
    history: undefined,
    audit: config.audit ?? true,
    routes: [...(config.routes ?? []), historyRoute],
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
