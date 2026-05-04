/**
 * AccessControl — composable access-control logic extracted from BaseController.
 *
 * Handles ID filtering, policy filter checking, org/tenant scope validation,
 * ownership verification, and fetch-with-access-control patterns.
 *
 * ## Policy-filter enforcement model (v2.10.6)
 *
 * Arc delegates policy-filter matching to the **database** on every primary
 * fetch: `buildIdFilter` composes a compound filter (id + `_policyFilters` +
 * tenant) and `fetchDetailed` passes it to `repository.getOne(compoundFilter)`.
 * The DB evaluates its own dialect — MongoDB operators for mongokit, SQL
 * predicates for sqlitekit/pgkit, Prisma `WhereInput` for Prisma. Arc never
 * re-implements that.
 *
 * The only path that needs in-memory policy-filter validation is
 * `validateItemAccess` — used by `getBySlug` and cache revalidation, where
 * a doc has already been fetched through a non-compound path. For that
 * path, Arc delegates to `DataAdapter.matchesFilter` if the adapter supplies
 * one. If not, arc trusts the fetch path's own filtering and short-circuits
 * to `true`; a one-time warn surfaces the gap so adapter authors notice.
 *
 * Prior versions of arc shipped a ~200-LOC MongoDB-syntax fallback engine
 * here (`$eq` / `$ne` / `$in` / `$regex` / `$and` / `$or` / dot-paths with
 * ReDoS + prototype-pollution guards). That engine is removed in 2.10.6 —
 * it was dead code for mongokit users (the compound-filter path never
 * hits it) and actively wrong for non-Mongo adapters (applying Mongo
 * syntax to rows shaped by a different dialect silently misclassified).
 */

import type { QueryOptions } from "@classytic/repo-core/repository";
import { DEFAULT_ID_FIELD } from "../constants.js";
import { arcLog } from "../logger/index.js";
import { getOrgId as getOrgIdFromScope } from "../scope/types.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  IRequestContext,
  RequestContext,
} from "../types/index.js";
import { createDomainError } from "../utils/errors.js";
import { simpleEqualityMatcher } from "../utils/simpleEqualityMatcher.js";

const log = arcLog("access-control");

// ============================================================================
// Fetch Result — detailed denial reason for DX-friendly 404 responses
// ============================================================================

/** Denial reason codes returned by `fetchDetailed()`. */
export type FetchDenialReason = "NOT_FOUND" | "POLICY_FILTERED" | "ORG_SCOPE_DENIED";

/** Result of a detailed fetch with access control. */
export interface FetchResult<TDoc> {
  /** The document, or null if denied. */
  doc: TDoc | null;
  /** Null when the doc was found. A string code when denied. */
  reason: FetchDenialReason | null;
}

// ============================================================================
// Configuration
// ============================================================================

export interface AccessControlConfig {
  /** Field name used for multi-tenant scoping (default: 'organizationId'). Set to `false` to disable org filtering. */
  tenantField: string | false;
  /** Primary key field name (default: '_id') */
  idField: string;
  /**
   * Custom filter matching for policy enforcement.
   * Provided by the DataAdapter for non-MongoDB databases (SQL, etc.).
   * Falls back to built-in MongoDB-style matching if not provided.
   */
  matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;
}

/** Minimal repository interface for access-controlled fetch operations */
export interface AccessControlRepository {
  getById(id: string, options?: QueryOptions): Promise<unknown>;
  getOne?: (filter: AnyRecord, options?: QueryOptions) => Promise<unknown>;
}

// ============================================================================
// AccessControl Class
// ============================================================================

export class AccessControl {
  private readonly tenantField: string | false;
  private readonly idField: string;
  private readonly _adapterMatchesFilter?: (
    item: unknown,
    filters: Record<string, unknown>,
  ) => boolean;
  /**
   * One-shot latch for the "adapter didn't supply matchesFilter, in-memory
   * policy-filter re-check is skipped" warning. The primary fetch path
   * (`getOne(compoundFilter)`) already applied filters at the DB layer;
   * this warn only fires when `validateItemAccess` runs and the adapter
   * hasn't provided a native matcher for the post-hoc re-check.
   */
  private _warnedNoMatcher = false;

  constructor(config: AccessControlConfig) {
    this.tenantField = config.tenantField;
    this.idField = config.idField;
    this._adapterMatchesFilter = config.matchesFilter;
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Build filter for single-item operations (get/update/delete)
   * Combines ID filter with policy/org filters for proper security enforcement
   */
  buildIdFilter(id: string, req: IRequestContext): AnyRecord {
    const filter: AnyRecord = { [this.idField]: id };
    const arcContext = this._meta(req);

    // Apply policy filters (set by permission middleware via req.metadata._policyFilters)
    const policyFilters = arcContext?._policyFilters;
    if (policyFilters) {
      Object.assign(filter, policyFilters);
    }

    // Apply org/tenant scope filter — derived from request.scope
    // Skip for platform-universal resources (tenantField: false)
    const scope = arcContext?._scope;
    const orgId = scope ? getOrgIdFromScope(scope) : undefined;
    if (this.tenantField && orgId && !policyFilters?.[this.tenantField]) {
      filter[this.tenantField] = orgId;
    }

    return filter;
  }

  /**
   * Check if a post-fetch item matches the request's `_policyFilters`.
   *
   * **When this runs:** only on paths where the primary fetch path did NOT
   * apply policy filters at the DB layer — notably `validateItemAccess`
   * (used by `getBySlug` and cache revalidation). The main `fetchDetailed`
   * path builds a compound filter (`buildIdFilter`) and passes it to
   * `repository.getOne(compoundFilter)`, so the DB has already enforced
   * the filter and an in-memory re-check would be redundant.
   *
   * **Evaluation order (fail-closed):**
   * 1. No `_policyFilters` set → `true` (nothing to enforce).
   * 2. Adapter supplied `matchesFilter` → delegate to it verbatim. Adapters
   *    are expected to handle every filter shape the host emits
   *    (mongokit/sqlitekit evaluate at the DB layer; Prisma/custom engines
   *    can wrap their own predicate engine).
   * 3. No adapter matcher → fall back to `simpleEqualityMatcher` — arc's
   *    built-in flat-key equality helper. This is defense-in-depth for the
   *    common case: arc's own permission helpers emit flat filters
   *    (`{userId: …}`, `{organizationId: …}`), which this matcher evaluates
   *    correctly. Operator-shaped filters (`$in`, `$ne`, `$regex`, `$and`,
   *    `$or`) are **rejected** (the matcher returns `false`) — fail-closed
   *    rather than fail-open. A one-shot warn flags the gap so adapter
   *    authors can wire a richer matcher.
   *
   * Arc deliberately does NOT ship a full MongoDB-syntax matcher:
   * re-implementing Mongo in JS was dead code for mongokit users (the DB
   * did it) and silently wrong for non-Mongo adapters. The flat-equality
   * fallback is small (~20 LOC), correct in both dialects, and closes the
   * previous `getBySlug`-style policy-bypass path.
   */
  checkPolicyFilters(item: AnyRecord, req: IRequestContext): boolean {
    // Policy filters are set by permission middleware via req.metadata._policyFilters
    const arcContext = this._meta(req);
    const policyFilters = arcContext?._policyFilters;
    if (!policyFilters || Object.keys(policyFilters).length === 0) return true;

    // Adapter-supplied matcher wins — it's the only way to correctly
    // evaluate operator-shaped filters (`$in`, `$regex`, `$and`, etc.).
    if (this._adapterMatchesFilter) {
      return this._adapterMatchesFilter(item, policyFilters);
    }

    // Defense-in-depth default: flat-equality enforcement. Rejects
    // operator-shaped values (fail-closed) so custom `getBySlug`
    // implementations that don't filter at their DB layer still have the
    // 95%-case flat filters caught here.
    const hasOperator = Object.values(policyFilters).some(
      (v) =>
        v !== null &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.getPrototypeOf(v) === Object.prototype &&
        Object.keys(v).some((k) => k.startsWith("$")),
    );
    if (hasOperator) this._warnNoMatcher(policyFilters);
    return simpleEqualityMatcher(item, policyFilters);
  }

  /**
   * Emit a one-shot warn when policy filters contain operators (`$in`,
   * `$ne`, `$regex`, etc.) and no `DataAdapter.matchesFilter` is wired —
   * arc's flat-equality fallback fail-closes on operators, so the host
   * sees 404s on docs that should match. Latched on `_warnedNoMatcher`
   * so subsequent requests stay quiet.
   */
  private _warnNoMatcher(policyFilters: AnyRecord): void {
    if (this._warnedNoMatcher) return;
    this._warnedNoMatcher = true;
    log.warn(
      "`_policyFilters` contains operator-shaped entries (e.g. `$in`, `$ne`, `$regex`) " +
        "but `DataAdapter.matchesFilter` is not set. Arc's flat-equality fallback cannot " +
        "evaluate operators and will reject these items on non-compound fetches " +
        "(`validateItemAccess`, `getBySlug`, cache revalidation). Wire up `matchesFilter` " +
        "on your adapter — use `matchFilter` from `@classytic/repo-core/filter` for IR-based " +
        "adapters, or your DB's native predicate engine.",
      { policyFilterKeys: Object.keys(policyFilters) },
    );
  }

  /**
   * Check org/tenant scope for a document — uses configurable tenantField.
   *
   * SECURITY: When org scope is active (orgId present), documents that are
   * missing the tenant field are DENIED by default. This prevents legacy or
   * unscoped records from leaking across tenants.
   */
  checkOrgScope(
    item: AnyRecord | null,
    arcContext: ArcInternalMetadata | RequestContext | undefined,
  ): boolean {
    // Platform-universal resources (tenantField: false) skip org scope check entirely
    if (!this.tenantField) return true;
    const scope = (arcContext as ArcInternalMetadata | undefined)?._scope;
    const orgId = scope ? getOrgIdFromScope(scope) : undefined;
    // No item, or no active org scope (including elevated admins viewing
    // across tenants) → skip. The elevated-without-org case is already
    // covered by `!orgId` here, no separate branch needed.
    if (!item || !orgId) return true;
    const itemOrgId = item[this.tenantField];
    // SECURITY: Deny records missing the tenant field when org scope is active.
    // This prevents legacy/unscoped records from leaking across orgs.
    if (!itemOrgId) return false;
    return String(itemOrgId) === String(orgId);
  }

  /** Check ownership for update/delete (ownedByUser preset) */
  checkOwnership(item: AnyRecord | null, req: IRequestContext): boolean {
    // Ownership check would need to be passed via req.metadata
    const ownershipCheck = this._meta(req)?._ownershipCheck;
    if (!item || !ownershipCheck) return true;
    const { field, userId } = ownershipCheck;
    const itemOwnerId = item[field];
    if (!itemOwnerId) return true;
    return String(itemOwnerId) === String(userId);
  }

  /**
   * Fetch a single document with full access control enforcement.
   * Combines compound DB filter (ID + org + policy) with post-hoc fallback.
   *
   * Takes repository as a parameter to avoid coupling.
   *
   * Replaces the duplicated pattern in get/update/delete:
   *   buildIdFilter -> getOne (or getById + checkOrgScope + checkPolicyFilters)
   */
  async fetchWithAccessControl<TDoc>(
    id: string,
    req: IRequestContext,
    repository: AccessControlRepository,
    queryOptions?: QueryOptions,
  ): Promise<TDoc | null> {
    const result = await this.fetchDetailed<TDoc>(id, req, repository, queryOptions);
    return result.doc;
  }

  /**
   * Same as `fetchWithAccessControl` but returns a structured result with
   * a denial reason so callers can distinguish "doc doesn't exist" from
   * "doc exists but was filtered by policy/org scope" from "repo threw".
   *
   * Codes:
   * - `null`               — doc was found, no denial
   * - `'NOT_FOUND'`        — doc genuinely doesn't exist in the DB
   * - `'POLICY_FILTERED'`  — doc exists but the request's policy filters exclude it
   * - `'ORG_SCOPE_DENIED'` — doc exists but the caller's org context doesn't match
   * - `'REPO_ERROR'`       — the repository threw a "not found" error (mongokit style)
   */
  async fetchDetailed<TDoc>(
    id: string,
    req: IRequestContext,
    repository: AccessControlRepository,
    queryOptions?: QueryOptions,
  ): Promise<FetchResult<TDoc>> {
    const compoundFilter = this.buildIdFilter(id, req);
    const hasCompoundFilters = Object.keys(compoundFilter).length > 1;
    const needsCompoundLookup = hasCompoundFilters || this.idField !== DEFAULT_ID_FIELD;

    // Adapter contract: "not found" is signalled by returning null; real errors
    // propagate. Exception — some adapters (notably @classytic/mongokit) throw
    // an Error with a structural `status: 404` property to match HTTP
    // semantics. Translate those to null reliably via STRUCTURAL check, not
    // message sniffing — this avoids the pre-v2.9 bug where "index 'x' not
    // found" got misclassified as a missing document.
    const translateStatus404 = (error: unknown): { doc: null; reason: "NOT_FOUND" } | null => {
      if (error && typeof error === "object" && (error as { status?: unknown }).status === 404) {
        return { doc: null, reason: "NOT_FOUND" };
      }
      return null;
    };

    try {
      if (needsCompoundLookup && typeof repository.getOne === "function") {
        const doc = (await repository.getOne(compoundFilter, queryOptions)) as TDoc | null;
        if (doc) return { doc, reason: null };

        // The compound filter didn't match — the doc may still exist without
        // the policy/tenant fields. Attempt a DIAGNOSTIC ID-only lookup to
        // distinguish "missing" from "filtered". This is read-only
        // introspection; security is already enforced by the compound
        // filter having returned null.
        //
        // Strategy: prefer an UNSCOPED probe so we can still classify
        // cross-tenant access as `ORG_SCOPE_DENIED`. Some plugin-scoped
        // repositories (notably mongokit's `multiTenantPlugin`) reject a
        // bare `getOne()` with "Missing 'organizationId' in context" — when
        // that happens, retry under the caller's scope. The scoped retry
        // loses cross-tenant visibility (a doc in another org becomes
        // `NOT_FOUND`), but preserves POLICY_FILTERED accuracy within the
        // caller's tenant and avoids propagating an unrelated error.
        if (hasCompoundFilters) {
          const idOnly: AnyRecord = { [this.idField]: id };
          // Bind to the repository so the method keeps its `this` when
          // re-invoked. Extracting `repository.getOne` without binding
          // breaks kits that reach into `this._buildContext` (mongokit,
          // sqlitekit, any repo-core descendant) — those threw a 500
          // `Cannot read properties of undefined (reading '_buildContext')`
          // before this binding was added.
          const rawGetOne = (
            repository.getOne as (f: AnyRecord, o?: QueryOptions) => Promise<unknown>
          ).bind(repository) as (f: AnyRecord, o?: QueryOptions) => Promise<unknown>;

          let rawDoc: unknown = null;
          try {
            rawDoc = await rawGetOne(idOnly);
          } catch (unscopedErr) {
            // `status: 404` already means "missing" — no need to retry.
            if (translateStatus404(unscopedErr)) {
              return { doc: null, reason: "NOT_FOUND" };
            }
            // Plugin-scoped repo refused the unscoped probe. Fall back to
            // the caller's scope so we still get in-tenant diagnostic.
            // Cross-tenant visibility is lost here (a doc in another org
            // becomes `NOT_FOUND` rather than `ORG_SCOPE_DENIED`), but
            // POLICY_FILTERED accuracy within the caller's tenant is
            // preserved and we avoid propagating an unrelated error.
            try {
              rawDoc = await rawGetOne(idOnly, queryOptions);
            } catch (scopedErr) {
              if (translateStatus404(scopedErr)) {
                return { doc: null, reason: "NOT_FOUND" };
              }
              // Give up on diagnostic detail — surface the underlying error
              // so callers see real failures instead of a silent downgrade.
              throw scopedErr;
            }
          }

          if (rawDoc) {
            // Doc exists but didn't match the compound filter. Determine why.
            const arcContext = this._meta(req);
            if (!this.checkOrgScope(rawDoc as AnyRecord, arcContext)) {
              return { doc: null, reason: "ORG_SCOPE_DENIED" };
            }
            return { doc: null, reason: "POLICY_FILTERED" };
          }
        }
        return { doc: null, reason: "NOT_FOUND" };
      }

      // Fallback: default _id lookups
      if (this.idField !== DEFAULT_ID_FIELD) {
        if (typeof repository.getOne !== "function") {
          throw createDomainError(
            "arc.adapter.capability_required",
            `Resource with idField="${this.idField}" requires repository.getOne() to look up by custom field. ` +
              `Arc's BaseController cannot fall back to getById() because it would query by _id.`,
            501,
            { capability: "getOne", idField: this.idField },
          );
        }
      }

      const item = (await repository.getById(id, queryOptions)) as TDoc | null;
      if (!item) return { doc: null, reason: "NOT_FOUND" };

      const arcContext = this._meta(req);
      if (!this.checkOrgScope(item as AnyRecord, arcContext)) {
        return { doc: null, reason: "ORG_SCOPE_DENIED" };
      }
      if (!this.checkPolicyFilters(item as AnyRecord, req)) {
        return { doc: null, reason: "POLICY_FILTERED" };
      }

      return { doc: item, reason: null };
    } catch (error: unknown) {
      const translated = translateStatus404(error);
      if (translated) return translated;
      throw error;
    }
  }

  /**
   * Post-fetch access control validation for items fetched by non-ID queries
   * (e.g., getBySlug, restore). Applies org scope, policy filters, and
   * ownership checks — the same guarantees as fetchWithAccessControl.
   */
  validateItemAccess(item: AnyRecord | null, req: IRequestContext): boolean {
    if (!item) return false;

    const arcContext = this._meta(req);
    if (!this.checkOrgScope(item, arcContext)) return false;
    if (!this.checkPolicyFilters(item, req)) return false;

    return true;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /** Extract typed Arc internal metadata from request */
  private _meta(req: IRequestContext): ArcInternalMetadata | undefined {
    return req.metadata as ArcInternalMetadata | undefined;
  }
}
