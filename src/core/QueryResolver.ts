/**
 * QueryResolver - Composable query resolution logic extracted from BaseController.
 *
 * Resolves a request into parsed query options (pagination, filters, sorting,
 * select, populate) in a single pass. Applies org/tenant scope and policy
 * filters from the request metadata.
 *
 * Designed to be used standalone or composed into controllers.
 */

import { isProductionEnv } from "@classytic/primitives/environment";
import { DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_TENANT_FIELD } from "../constants.js";
import { arcLog } from "../logger/index.js";
import { conjoinPolicyFilters } from "../permissions/filter-merge.js";
import { getOrgId as getOrgIdFromScope } from "../scope/types.js";
import type {
  AnyRecord,
  ArcInternalMetadata,
  ControllerQueryOptions,
  IRequestContext,
  LookupOption,
  QueryParserInterface,
  RouteSchemaOptions,
  UserLike,
} from "../types/index.js";
import { ValidationError } from "../utils/errors.js";
import { ArcQueryParser } from "../utils/queryParser.js";
import { collectReadBlockedFields } from "./fieldRulePredicates.js";
import { toRepositoryFilter } from "./repositoryFilter.js";

// ============================================================================
// Configuration
// ============================================================================

export interface QueryResolverConfig {
  /** Query parser instance (default: Arc built-in parser) */
  queryParser?: QueryParserInterface;
  /** Maximum limit for pagination (default: 100) */
  maxLimit?: number;
  /** Default limit for pagination (default: 20) */
  defaultLimit?: number;
  /**
   * Default sort applied when the request doesn't specify one.
   *   - `string` — e.g. `'-createdAt'` (Mongo convention: leading `-` = DESC).
   *   - `false` — disable the default; resolved query has no `sort` clause.
   *     Use for SQL kits without a `createdAt` column.
   * Defaults to `'-createdAt'` for back-compat with mongokit consumers.
   */
  defaultSort?: string | false;
  /** Schema options for field sanitization */
  schemaOptions?: RouteSchemaOptions;
  /** Field name used for multi-tenant scoping (default: 'organizationId'). Set to `false` to disable. */
  tenantField?: string | false;
}

// ============================================================================
// Default Query Parser
// ============================================================================

const defaultParser = new ArcQueryParser();

export function getDefaultQueryParser(): QueryParserInterface {
  return defaultParser;
}

const log = arcLog("query");

/**
 * Deny-by-default (2.24 flip): `populate=` / `lookup=` with NO allowlist
 * configured is rejected — client-driven joins/population are an easy
 * accidental N+1 / expensive-join surface, and "absent means all" made
 * every resource opt into it silently. A one-shot dev log explains the
 * drop the first time a request hits it.
 */
let notedDeniedJoins = false;
function noteDeniedJoins(kind: "populate" | "lookups"): void {
  // Shared classifier, not a raw comparison: with `NODE_ENV=prod` the raw form treated a production
  // deployment as non-production and emitted this dev-only note in production logs.
  if (notedDeniedJoins || isProductionEnv(process.env.NODE_ENV)) return;
  notedDeniedJoins = true;
  log.warn(
    `client requested ${kind} but no allowlist is configured — DENIED (2.24 default flip; ` +
      "it was allow-all). Set schemaOptions.query.allowedPopulate / allowedLookups to enable " +
      "client-driven joins. (dev-only note, shown once)",
  );
}

/**
 * A `$lookup` reaches ANOTHER collection, and the tenant filter arc conjoins applies to the
 * BASE one only. The joined side carries whatever predicate the lookup itself names and
 * nothing more — no tenant scope, no soft-delete filter — so a resource that opens
 * `allowedLookups` can return rows from a collection the caller could not query directly.
 *
 * Unreachable by default (2.24 denies `lookup=` with no allowlist) and no resource in this
 * fleet configures one, so this is a WARNING at the moment a deployment first opts in
 * rather than machinery for a door nobody has opened. Warned once per collection set: the
 * decision is made when the allowlist is written, not per request.
 *
 * Scope the join with the lookup's own `where`, which mongokit compiles into a `$match`
 * inside the lookup pipeline.
 */
const notedUnscopedJoins = new Set<string>();
function noteUnscopedJoin(lookups: ReadonlyArray<{ from?: string }>): void {
  const collections = lookups
    .map((l) => l.from)
    .filter((f): f is string => typeof f === "string")
    .sort();
  const key = collections.join(",");
  if (key.length === 0 || notedUnscopedJoins.has(key)) return;
  notedUnscopedJoins.add(key);
  log.warn(
    `client-driven $lookup on [${key}] — the JOINED side carries no tenant or soft-delete ` +
      "filter (arc scopes the base collection only). Narrow each lookup with its own " +
      "`where`, or the join can surface rows the caller cannot query directly. (shown once)",
  );
}

// ============================================================================
// QueryResolver Class
// ============================================================================

export class QueryResolver {
  private queryParser: QueryParserInterface;
  private maxLimit: number;
  /** Set only when the HOST passed one — it outranks any parser's cap, at any time. */
  private readonly explicitMaxLimit: number | undefined;
  private defaultLimit: number;
  /** `undefined` means "no default sort" (caller passed `false`). */
  private defaultSort: string | undefined;
  private readonly explicitDefaultSort: boolean;
  private schemaOptions: RouteSchemaOptions;
  private tenantField: string | false;

  constructor(config: QueryResolverConfig = {}) {
    this.queryParser = config.queryParser ?? getDefaultQueryParser();
    /**
     * Precedence: explicit config → the PARSER's own cap → framework default.
     *
     * The middle term is the fix. A resource that writes
     * `new QueryParser({ maxLimit: 1000 })` has already answered "how large may a page
     * be?", and arc previously ignored that and applied 100 anyway. Three layers each
     * capping independently, lowest wins, no signal — a chart-of-accounts picker
     * returned 100 of 696 rows and rendered "No accounts found", while the resource
     * AND the repository were both configured for 1000.
     *
     * Note it reads `config.queryParser`, NOT `this.queryParser`. The fallback default
     * parser declares its own generous cap, so deferring to it would silently raise the
     * ceiling from 100 to 1000 on every endpoint that never configured one — a widening
     * nobody asked for. Only a parser the resource EXPLICITLY supplied counts as an
     * answer; a test pins exactly this.
     */
    this.explicitMaxLimit = config.maxLimit;
    this.maxLimit = config.maxLimit ?? config.queryParser?.maxLimit ?? 100;
    this.defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
    // `false` → opt out entirely (no default sort). `undefined` → framework
    // default (`-createdAt`, mongokit convention). Any string passes through.
    this.defaultSort =
      config.defaultSort === false ? undefined : (config.defaultSort ?? DEFAULT_SORT);
    // Whether the HOST named a default sort, as opposed to inheriting the
    // framework's. Only the framework's is silently withdrawn when the parser
    // forbids the field — a host's own choice gets a boot diagnostic instead,
    // because a contradiction they wrote is theirs to resolve.
    this.explicitDefaultSort = config.defaultSort !== undefined && config.defaultSort !== false;
    this.schemaOptions = config.schemaOptions ?? {};
    this.tenantField = config.tenantField !== undefined ? config.tenantField : DEFAULT_TENANT_FIELD;
  }

  /**
   * Swap the underlying parser. Mutates in place so the resolver instance
   * stays referentially stable (hosts capturing a `queryResolver` ref via
   * `defineResource({ controller })` keep that ref valid). Single source of
   * truth — pairs with `BaseCrudController.setQueryParser()`.
   */
  setParser(parser: QueryParserInterface): void {
    this.queryParser = parser;
    /**
     * The swapped-in parser's cap applies too — swapping is how most resources supply
     * theirs.
     *
     * Deferring only in the constructor was not enough: `setQueryParser()` mutates the
     * resolver in place so captured references stay valid, so a resource that declares
     * `new QueryParser({ maxLimit: 1000 })` arrives HERE, not through `config`. The
     * constructor-only version of this fix looked right, passed its unit tests, and
     * changed nothing at runtime — the chart of accounts still served 100 of 696.
     *
     * An explicit `config.maxLimit` still wins; that is a host decision and outranks a
     * package default either way.
     */
    if (this.explicitMaxLimit === undefined && parser.maxLimit !== undefined) {
      this.maxLimit = parser.maxLimit;
    }
  }

  /**
   * The default sort, but only when the parser permits the field.
   *
   * A resource declaring `allowedSortFields` has stated exactly what may be
   * sorted on. Arc then applied its OWN default of `-createdAt` on top, and
   * mongokit 3.31 REJECTS a sort outside the allowlist rather than dropping it —
   * so every list call on such a resource answered 400, `Blocked sort field not
   * in allowlist: createdAt`. REST and MCP alike; the endpoint was unusable, and
   * nothing the caller sent could avoid it.
   *
   * A general default must never outrank a specific declaration, so the
   * FRAMEWORK default withdraws. A HOST-declared `defaultSort` is left alone —
   * that contradiction is its author's to resolve, and `defineResource` reports
   * it as a boot diagnostic instead of arc silently picking a winner.
   */
  private permittedDefaultSort(): string | undefined {
    const sort = this.defaultSort;
    if (sort === undefined || this.explicitDefaultSort) return sort;
    const allowed = this.queryParser.allowedSortFields;
    if (!allowed || allowed.length === 0) return sort;
    const fields = sort
      .split(",")
      .map((s) => s.trim().replace(/^-/, ""))
      .filter(Boolean);
    return fields.every((f) => allowed.includes(f)) ? sort : undefined;
  }

  /**
   * Resolve a request into parsed query options -- ONE parse per request.
   * Combines what was previously _buildContext + _parseQueryOptions + _applyFilters.
   */
  resolve(req: IRequestContext, meta?: ArcInternalMetadata): ControllerQueryOptions {
    /**
     * Strip `_policyFilters` BEFORE the parse, not after.
     *
     * **Reachable only when a CLIENT puts it in the URL.** Trusted policy is a
     * request DECORATION (`request._policyFilters`, set by the permission
     * middleware) that `createRequestContext` lifts into `metadata` — it never
     * enters `req.query`, which is Fastify's parsed querystring. So the key
     * arriving here is always user-supplied, always inert (the authoritative
     * copy is read from `arcContext` below), and must simply not reach the
     * parser.
     *
     * The previous `delete` ran on `parsed.filters` — AFTER
     * `queryParser.parse()` — so on the one path that needed it, it could
     * never run: a KIT parser validates every key against the resource's
     * `allowedFilterFields` and throws during the parse, before the cleanup
     * line. Arc's own parser skips the key via `RESERVED_QUERY_PARAMS`, so the
     * two parsers disagreed on the same request: arc ignored a probe, kits
     * 400'd it.
     *
     * Stripping here makes them agree, and agrees with arc. Nothing is
     * weakened — the client's value was already inert — but note the trade:
     * under a kit parser `?_policyFilters=…` used to be a loud 400 and is now
     * silently dropped. The alternative, teaching every kit's reserved-key list
     * about an arc-internal key, spreads one framework's leak across the
     * ecosystem for the same outcome.
     *
     * Copy only when present: the hot path allocates nothing, and `req.query`
     * is never mutated (it is shared with the rest of the request).
     */
    const rawQuery = req.query as AnyRecord | undefined;
    let query = rawQuery;
    if (rawQuery && "_policyFilters" in rawQuery) {
      const { _policyFilters: _ignored, ...rest } = rawQuery;
      query = rest;
    }

    const parsed = this.queryParser.parse(query);

    /**
     * Client-supplied keys only, and BEFORE the policy conjunction below: trusted policy
     * legitimately filters on hidden fields (`requireOwnership('userId')` emits exactly that),
     * so checking the conjoined result would reject the framework's own restrictions.
     */
    this.assertNoBlockedReadKeys(parsed.filters as AnyRecord | undefined, parsed.sort);

    const arcContext = meta ?? (req.metadata as ArcInternalMetadata | undefined);

    // Enforce limits
    const limit = Math.min(Math.max(1, parsed.limit || this.defaultLimit), this.maxLimit);
    // Only set page if not using keyset pagination (after/cursor)
    const page = parsed.after ? undefined : parsed.page ? Math.max(1, parsed.page) : 1;

    // Convert sort object to string if needed
    const sortString = parsed.sort
      ? Object.entries(parsed.sort)
          .map(([k, v]) => (v === -1 ? `-${k}` : k))
          .join(",")
      : this.permittedDefaultSort();

    // Preserve parsed select format (object from MongoKit, string from Arc parser)
    // Sanitize blocked fields regardless of format
    const rawSelect = parsed.select ?? (req.query?.select as string | undefined);

    // Build filters with policy + tenant scope applied. Both `parsed.filters`
    // (parser output) and `_policyFilters` (permission layer) are records in the
    // Mongo operator dialect — never repo-core IR (that appears only after the
    // `toRepositoryFilter` step below). So we compose them with
    // `conjoinPolicyFilters` (logical AND) rather than `Object.assign`: a
    // security restriction can never be silently overwritten by a same-key
    // user-supplied filter, and vice-versa. Records only in, IR out.
    const policyFilters = arcContext?._policyFilters;
    let filters: AnyRecord = conjoinPolicyFilters(
      parsed.filters as AnyRecord | undefined,
      policyFilters,
    );

    // Org/tenant scope -- derived from request.scope via metadata.
    // Skip for platform-universal resources (tenantField: false).
    const scope = arcContext?._scope;
    const orgId = scope ? getOrgIdFromScope(scope) : undefined;
    // `_crossTenantRead` is `multiTenantPreset({ crossTenant: [...] })` saying this listing is a
    // marketplace, not one tenant's shelf. Without this branch the preset's decision was undone
    // here, one layer down and out of sight: the route stopped filtering and the resolver put the
    // filter straight back, so a signed-in seller still saw only their own rows.
    if (this.tenantField && orgId && !arcContext?._crossTenantRead && !policyFilters?.[this.tenantField]) {
      // Only set if not already set by multiTenant preset — conjoined, so it
      // can't clobber (or be clobbered by) an existing constraint on the key.
      filters = conjoinPolicyFilters(filters, { [this.tenantField]: orgId });
    }

    // Normalize `$`-operator policy/query filters (`$or` from requireGrant,
    // `$and` from conjoinPolicyFilters, `$gte` from the Mongo-dialect parser)
    // to the portable repo-core Filter IR so every kit's query path compiles
    // them. Flat equality filters pass through unchanged. See
    // {@link toRepositoryFilter}.
    const portableFilters = toRepositoryFilter(filters);

    return {
      page,
      limit,
      sort: sortString,
      select: this.sanitizeSelectAny(rawSelect, this.schemaOptions),
      populate: this.sanitizePopulate(parsed.populate, this.schemaOptions),
      // Advanced populate options — sanitized against allowedPopulate
      populateOptions: this.sanitizePopulateOptions(parsed.populateOptions, this.schemaOptions),
      // Lookup/join options from MongoKit 3.4+ QueryParser (maps to $lookup / SQL JOIN)
      lookups: this.sanitizeLookups(parsed.lookups, this.schemaOptions),
      filters: portableFilters,
      // MongoKit features
      search: parsed.search,
      after: parsed.after,
      user: req.user as UserLike | undefined,
      context: arcContext,
    };
  }

  /**
   * Sanitize select — preserves the input format (string, array, or object).
   * This is critical for db-agnostic support: MongoKit returns object projections,
   * Mongoose uses space-separated strings, SQL adapters may use arrays.
   */
  private sanitizeSelectAny(
    select: string | string[] | Record<string, 0 | 1> | undefined,
    schemaOptions: RouteSchemaOptions,
  ): string | string[] | Record<string, 0 | 1> | undefined {
    const blockedFields = this.getBlockedFields(schemaOptions);
    if (blockedFields.length === 0) return select;
    const exclusion = (): Record<string, 0> =>
      Object.fromEntries(blockedFields.map((field) => [field, 0] as const));
    if (!select) return exclusion();

    // Object projection: { name: 1, email: 1, password: 0 }
    if (typeof select === "object" && !Array.isArray(select)) {
      const sanitized: Record<string, 0 | 1> = {};
      for (const [field, val] of Object.entries(select)) {
        if (!this.isBlockedProjection(field, blockedFields)) sanitized[field] = val;
      }
      return Object.keys(sanitized).length > 0 ? sanitized : exclusion();
    }

    // Array: ['name', 'email', '-password']
    if (Array.isArray(select)) {
      const sanitized = select.filter((f) => !this.isBlockedProjection(f, blockedFields));
      return sanitized.length > 0 ? sanitized : exclusion();
    }

    // String: "name email -password" or "name,email,-password"
    const fields = select.split(/[\s,]+/).filter(Boolean);
    const sanitized = fields.filter((f) => !this.isBlockedProjection(f, blockedFields));
    return sanitized.length > 0 ? sanitized.join(" ") : exclusion();
  }

  /** Sanitize populate fields */
  private sanitizePopulate(
    populate: unknown,
    schemaOptions: RouteSchemaOptions,
  ): string[] | undefined {
    if (!populate) return undefined;

    // 2.11.2: typed via `RouteSchemaOptions['query']` extension — no cast.
    const allowedPopulate = schemaOptions.query?.allowedPopulate;
    const requested =
      typeof populate === "string"
        ? populate.split(",").map((p) => p.trim())
        : Array.isArray(populate)
          ? populate.map(String)
          : [];

    if (requested.length === 0) return undefined;

    // Deny-by-default: no allowlist means NO client-driven populate.
    if (!allowedPopulate) {
      noteDeniedJoins("populate");
      return undefined;
    }

    const sanitized = requested.filter((p) => allowedPopulate.includes(p));
    return sanitized.length > 0 ? sanitized : undefined;
  }

  /** Sanitize advanced populate options against allowedPopulate */
  private sanitizePopulateOptions(
    options: import("../types/index.js").PopulateOption[] | undefined,
    schemaOptions: RouteSchemaOptions,
  ): import("../types/index.js").PopulateOption[] | undefined {
    if (!options || options.length === 0) return undefined;

    const allowedPopulate = schemaOptions.query?.allowedPopulate;

    // Deny-by-default: no allowlist means NO client-driven populate.
    if (!allowedPopulate) {
      noteDeniedJoins("populate");
      return undefined;
    }

    const sanitized = options.filter((opt) => allowedPopulate.includes(opt.path));
    return sanitized.length > 0 ? sanitized : undefined;
  }

  /**
   * Sanitize lookup/join options. Deny-by-default: `allowedLookups` must be
   * configured for any client-driven lookup to pass; listed collections are
   * then structurally validated to prevent injection.
   */
  private sanitizeLookups(
    lookups: LookupOption[] | undefined,
    schemaOptions: RouteSchemaOptions,
  ): LookupOption[] | undefined {
    if (!lookups || lookups.length === 0) return undefined;

    const allowedLookups = schemaOptions.query?.allowedLookups;

    // Deny-by-default: no allowlist means NO client-driven lookups.
    if (!allowedLookups) {
      noteDeniedJoins("lookups");
      return undefined;
    }

    const validFieldName = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

    const sanitized = lookups.filter((lookup) => {
      // Validate required fields exist and are safe strings
      if (!lookup.from || !lookup.localField || !lookup.foreignField) return false;
      if (!validFieldName.test(lookup.from)) return false;
      if (!validFieldName.test(lookup.localField)) return false;
      if (!validFieldName.test(lookup.foreignField)) return false;

      if (!allowedLookups.includes(lookup.from)) return false;

      return true;
    });

    if (sanitized.length > 0) noteUnscopedJoin(sanitized);

    return sanitized.length > 0 ? sanitized : undefined;
  }

  /**
   * Read-side allowlist gate for `select=` / `populate=`.
   *
   * Only `hidden: true` blocks. `systemManaged` is a *write* rule and
   * doesn't gate visibility — see `core/fieldRulePredicates.ts`.
   */
  private getBlockedFields(schemaOptions: RouteSchemaOptions): string[] {
    const blocked = collectReadBlockedFields(schemaOptions);
    return blocked ? Array.from(blocked) : [];
  }

  /**
   * Is this projection path blocked — by its own name, or by a hidden ANCESTOR?
   *
   * `hidden: { secret: true }` hides the object, and an exact-name match left its children
   * reachable: `?select=secret.value` projected the very field the rule exists to withhold.
   * A rule on a parent covers everything under it, which is what "hidden" already means to
   * whoever wrote it.
   */
  private isBlockedProjection(path: string, blockedFields: string[]): boolean {
    const field = path.replace(/^-/, "");
    return blockedFields.some((blocked) => field === blocked || field.startsWith(`${blocked}.`));
  }

  /**
   * Refuse a read that FILTERS or SORTS on a `hidden` field.
   *
   * `hidden` was enforced on the surfaces that RETURN a value — the response, `select=`,
   * `_distinct`, aggregations — but a filter key never returns the field, it INTERROGATES it:
   * `?passwordHash[like]=^ab` narrows the result set, so the row count answers a question about
   * a value the caller may not read. A resource with no `allowedFilterFields` was a blind
   * existence oracle over every hidden field it declared.
   *
   * Rejected rather than dropped, unlike `select`. Dropping a projection narrows what comes
   * back; dropping a filter WIDENS the rows, which is the silent-permissive shape this
   * framework fails loudly on everywhere else.
   *
   * Compound keys (`$or`, `$and`) are walked, because the offending key can be nested inside
   * one. A dotted path is blocked by its own name or by a hidden ancestor, so a rule on
   * `secret` also covers `secret.value`.
   */
  private assertNoBlockedReadKeys(
    filters: AnyRecord | undefined,
    sort: string | Record<string, unknown> | undefined,
  ): void {
    const blocked = collectReadBlockedFields(this.schemaOptions);
    if (!blocked) return;

    const offenders = new Set<string>();
    const isBlocked = (key: string): boolean => {
      if (blocked.has(key)) return true;
      const dot = key.indexOf(".");
      return dot > 0 && blocked.has(key.slice(0, dot));
    };

    // Depth is already bounded by the parser; the cap only stops a pathological structure.
    const walk = (node: unknown, depth: number): void => {
      if (depth > 8 || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        // `$or` / `$and` / `$nor` hold branches; a `$`-key is never a field name.
        if (key.startsWith("$")) {
          walk(value, depth + 1);
          continue;
        }
        if (isBlocked(key)) offenders.add(key);
      }
    };

    walk(filters, 0);

    // A parser may hand back either dialect: `{ field: -1 }` or `"-field,other"`.
    const sortKeys =
      typeof sort === "string"
        ? sort
            .split(",")
            .map((s) => s.trim().replace(/^-/, ""))
            .filter(Boolean)
        : Object.keys(sort ?? {});
    for (const key of sortKeys) {
      if (isBlocked(key)) offenders.add(key);
    }

    if (offenders.size === 0) return;
    const fields = [...offenders];
    throw new ValidationError(
      `Cannot filter or sort on hidden field(s): ${fields.join(", ")}`,
      fields.map((field) => ({ field, message: "Field is not readable" })),
    );
  }
}
