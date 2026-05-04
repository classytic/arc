/**
 * QueryResolver - Composable query resolution logic extracted from BaseController.
 *
 * Resolves a request into parsed query options (pagination, filters, sorting,
 * select, populate) in a single pass. Applies org/tenant scope and policy
 * filters from the request metadata.
 *
 * Designed to be used standalone or composed into controllers.
 */

import { DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_TENANT_FIELD } from "../constants.js";
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

// ============================================================================
// QueryResolver Class
// ============================================================================

export class QueryResolver {
  private queryParser: QueryParserInterface;
  private maxLimit: number;
  private defaultLimit: number;
  /** `undefined` means "no default sort" (caller passed `false`). */
  private defaultSort: string | undefined;
  private schemaOptions: RouteSchemaOptions;
  private tenantField: string | false;

  constructor(config: QueryResolverConfig = {}) {
    this.queryParser = config.queryParser ?? getDefaultQueryParser();
    this.maxLimit = config.maxLimit ?? 100;
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

    // Build filters with org + policy scope applied
    const filters = { ...(parsed.filters as AnyRecord) };

    // Policy filters (set by permission middleware via req.metadata._policyFilters)
    const policyFilters = arcContext?._policyFilters;
    if (policyFilters) {
      Object.assign(filters, policyFilters);
    }

    // Org/tenant scope -- derived from request.scope via metadata
    // Skip for platform-universal resources (tenantField: false)
    const scope = arcContext?._scope;
    const orgId = scope ? getOrgIdFromScope(scope) : undefined;
    if (this.tenantField && orgId && !policyFilters?.[this.tenantField]) {
      // Only set if not already set by multiTenant preset
      filters[this.tenantField] = orgId;
    }

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
      filters,
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

    // If no allowlist, allow all
    if (!allowedPopulate) return requested;

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

    // If no allowlist, allow all
    if (!allowedPopulate) return options;

    const sanitized = options.filter((opt) => allowedPopulate.includes(opt.path));
    return sanitized.length > 0 ? sanitized : undefined;
  }

  /**
   * Sanitize lookup/join options.
   * If schemaOptions.query.allowedLookups is set, only those collections are allowed.
   * Validates lookup structure to prevent injection.
   */
  private sanitizeLookups(
    lookups: LookupOption[] | undefined,
    schemaOptions: RouteSchemaOptions,
  ): LookupOption[] | undefined {
    if (!lookups || lookups.length === 0) return undefined;

    const allowedLookups = schemaOptions.query?.allowedLookups;

    const validFieldName = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

    const sanitized = lookups.filter((lookup) => {
      // Validate required fields exist and are safe strings
      if (!lookup.from || !lookup.localField || !lookup.foreignField) return false;
      if (!validFieldName.test(lookup.from)) return false;
      if (!validFieldName.test(lookup.localField)) return false;
      if (!validFieldName.test(lookup.foreignField)) return false;

      // If allowlist is set, enforce it
      if (allowedLookups && !allowedLookups.includes(lookup.from)) return false;

      return true;
    });

    return sanitized.length > 0 ? sanitized : undefined;
  }

  /** Get blocked fields from schema options */
  private getBlockedFields(schemaOptions: RouteSchemaOptions): string[] {
    const fieldRules = schemaOptions.fieldRules ?? {};
    return Object.entries(fieldRules)
      .filter(([, rules]) => rules.systemManaged || rules.hidden)
      .map(([field]) => field);
  }
}
