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
   * Resolve a request into parsed query options -- ONE parse per request.
   * Combines what was previously _buildContext + _parseQueryOptions + _applyFilters.
   */
  resolve(req: IRequestContext, meta?: ArcInternalMetadata): ControllerQueryOptions {
    const parsed = this.queryParser.parse(req.query);
    const arcContext = meta ?? (req.metadata as ArcInternalMetadata | undefined);

    // Remove internal params from filters
    delete (parsed.filters as AnyRecord)?._policyFilters;

    // Enforce limits
    const limit = Math.min(Math.max(1, parsed.limit || this.defaultLimit), this.maxLimit);
    // Only set page if not using keyset pagination (after/cursor)
    const page = parsed.after ? undefined : parsed.page ? Math.max(1, parsed.page) : 1;

    // Convert sort object to string if needed
    const sortString = parsed.sort
      ? Object.entries(parsed.sort)
          .map(([k, v]) => (v === -1 ? `-${k}` : k))
          .join(",")
      : this.defaultSort;

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
    if (this.tenantField && orgId && !policyFilters?.[this.tenantField]) {
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
    if (!select) return undefined;

    const blockedFields = this.getBlockedFields(schemaOptions);
    if (blockedFields.length === 0) return select;

    // Object projection: { name: 1, email: 1, password: 0 }
    if (typeof select === "object" && !Array.isArray(select)) {
      const sanitized: Record<string, 0 | 1> = {};
      for (const [field, val] of Object.entries(select)) {
        if (!blockedFields.includes(field)) sanitized[field] = val;
      }
      return Object.keys(sanitized).length > 0 ? sanitized : undefined;
    }

    // Array: ['name', 'email', '-password']
    if (Array.isArray(select)) {
      const sanitized = select.filter((f) => {
        const fieldName = f.replace(/^-/, "");
        return !blockedFields.includes(fieldName);
      });
      return sanitized.length > 0 ? sanitized : undefined;
    }

    // String: "name email -password" or "name,email,-password"
    const fields = select.split(/[\s,]+/).filter(Boolean);
    const sanitized = fields.filter((f) => {
      const fieldName = f.replace(/^-/, "");
      return !blockedFields.includes(fieldName);
    });
    return sanitized.length > 0 ? sanitized.join(" ") : undefined;
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
}
