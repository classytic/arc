/**
 * QueryResolver - Composable query resolution logic extracted from BaseController.
 *
 * Resolves a request into parsed query options (pagination, filters, sorting,
 * select, populate) in a single pass. Applies org/tenant scope and policy
 * filters from the request metadata.
 *
 * Designed to be used standalone or composed into controllers.
 */

import type {
  AnyRecord,
  ArcInternalMetadata,
  ControllerQueryOptions,
  IRequestContext,
  QueryParserInterface,
  RouteSchemaOptions,
  UserLike,
} from '../types/index.js';
import { getOrgId as getOrgIdFromScope } from '../scope/types.js';
import { DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_TENANT_FIELD } from '../constants.js';
import { ArcQueryParser } from '../utils/queryParser.js';

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
  /** Default sort field (default: '-createdAt') */
  defaultSort?: string;
  /** Schema options for field sanitization */
  schemaOptions?: RouteSchemaOptions;
  /** Field name used for multi-tenant scoping (default: 'organizationId') */
  tenantField?: string;
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
  private defaultSort: string;
  private schemaOptions: RouteSchemaOptions;
  private tenantField: string;

  constructor(config: QueryResolverConfig = {}) {
    this.queryParser = config.queryParser ?? getDefaultQueryParser();
    this.maxLimit = config.maxLimit ?? 100;
    this.defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
    this.defaultSort = config.defaultSort ?? DEFAULT_SORT;
    this.schemaOptions = config.schemaOptions ?? {};
    this.tenantField = config.tenantField ?? DEFAULT_TENANT_FIELD;
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
    const page = parsed.after ? undefined : (parsed.page ? Math.max(1, parsed.page) : 1);

    // Convert sort object to string if needed
    const sortString = parsed.sort
      ? Object.entries(parsed.sort)
          .map(([k, v]) => (v === -1 ? `-${k}` : k))
          .join(',')
      : this.defaultSort;

    // Use parsed.select if available, otherwise fall back to raw query string
    const selectString = this.selectToString(parsed.select) ?? (req.query?.select as string);

    // Build filters with org + policy scope applied
    const filters = { ...(parsed.filters as AnyRecord) };

    // Policy filters (set by permission middleware via req.metadata._policyFilters)
    const policyFilters = arcContext?._policyFilters;
    if (policyFilters) {
      Object.assign(filters, policyFilters);
    }

    // Org/tenant scope -- derived from request.scope via metadata
    const scope = arcContext?._scope;
    const orgId = scope ? getOrgIdFromScope(scope) : undefined;
    if (orgId && !policyFilters?.[this.tenantField]) {
      // Only set if not already set by multiTenant preset
      filters[this.tenantField] = orgId;
    }

    return {
      page,
      limit,
      sort: sortString,
      select: this.sanitizeSelect(selectString, this.schemaOptions),
      populate: this.sanitizePopulate(parsed.populate, this.schemaOptions),
      // Advanced populate options from MongoKit QueryParser (takes precedence over simple populate)
      populateOptions: parsed.populateOptions,
      filters,
      // MongoKit features
      search: parsed.search,
      after: parsed.after,
      user: req.user as UserLike | undefined,
      context: arcContext,
    };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Convert parsed select object to string format
   * Converts { name: 1, email: 1, password: 0 } -> 'name email -password'
   */
  private selectToString(select: string | string[] | Record<string, 0 | 1> | undefined): string | undefined {
    if (!select) return undefined;

    // Already a string
    if (typeof select === 'string') return select;

    // Array of fields
    if (Array.isArray(select)) return select.join(' ');

    // Object projection
    if (Object.keys(select).length === 0) return undefined;
    return Object.entries(select)
      .map(([field, include]) => (include === 0 ? `-${field}` : field))
      .join(' ');
  }

  /** Sanitize select fields */
  private sanitizeSelect(
    select: string | undefined,
    schemaOptions: RouteSchemaOptions
  ): string | undefined {
    if (!select) return undefined;

    const blockedFields = this.getBlockedFields(schemaOptions);
    if (blockedFields.length === 0) return select;

    const fields = select.split(/[\s,]+/).filter(Boolean);
    const sanitized = fields.filter((f) => {
      const fieldName = f.replace(/^-/, '');
      return !blockedFields.includes(fieldName);
    });

    return sanitized.length > 0 ? sanitized.join(' ') : undefined;
  }

  /** Sanitize populate fields */
  private sanitizePopulate(
    populate: unknown,
    schemaOptions: RouteSchemaOptions
  ): string[] | undefined {
    if (!populate) return undefined;

    const allowedPopulate = (schemaOptions.query as AnyRecord | undefined)?.allowedPopulate as string[] | undefined;
    const requested = typeof populate === 'string'
      ? populate.split(',').map((p) => p.trim())
      : Array.isArray(populate) ? populate.map(String) : [];

    if (requested.length === 0) return undefined;

    // If no allowlist, allow all
    if (!allowedPopulate) return requested;

    const sanitized = requested.filter((p) => allowedPopulate.includes(p));
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
