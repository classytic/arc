/**
 * Query / Request Context Types — controller query options, parsed query
 * shape, query-parser interface, request context, ownership checks,
 * service context.
 */

import "./base.js";

/**
 * Request-shaped context object passed to controller methods. Apps and
 * adapters extend it freely via the index signature.
 */
export interface RequestContext {
  operation?: string;
  user?: unknown;
  filters?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Internal metadata shape injected by Arc's Fastify adapter. Extends
 * RequestContext with known internal fields so controllers can access
 * them without `as AnyRecord` casts.
 */
export interface ArcInternalMetadata extends RequestContext {
  /** Policy filters from permission middleware */
  _policyFilters?: Record<string, unknown>;
  /** Request scope from scope resolution */
  _scope?: import("../scope/types.js").RequestScope;
  /** Ownership check config from ownedByUser preset */
  _ownershipCheck?: { field: string; userId: string };
  /** Arc instance references (hooks, field permissions, etc.) */
  arc?: {
    hooks?: import("../hooks/HookSystem.js").HookSystem;
    fields?: import("../permissions/fields.js").FieldPermissionMap;
    [key: string]: unknown;
  };
}

/**
 * Controller-level query options — parsed from request query string.
 * Includes pagination, filtering, populate/lookup, and context data.
 */
export interface ControllerQueryOptions {
  page?: number;
  limit?: number;
  sort?: string | Record<string, 1 | -1>;
  /** Simple populate (comma-separated string or array) */
  populate?: string | string[] | Record<string, unknown>;
  /**
   * Advanced populate options (Mongoose-compatible). When set, takes
   * precedence over simple `populate`.
   */
  populateOptions?: PopulateOption[];
  /**
   * Lookup/join options (database-agnostic). MongoKit maps these to
   * `$lookup`; future SQL adapters would map to JOINs.
   *
   * @example
   * URL: ?lookup[category][from]=categories&lookup[category][localField]=categorySlug&lookup[category][foreignField]=slug
   */
  lookups?: LookupOption[];
  select?: string | string[] | Record<string, 0 | 1>;
  filters?: Record<string, unknown>;
  search?: string;
  lean?: boolean;
  after?: string;
  user?: unknown;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Database-agnostic lookup/join option. Parsed from URL:
 * `?lookup[alias][from]=...&lookup[alias][localField]=...&lookup[alias][foreignField]=...`
 */
export interface LookupOption {
  /** Source collection/table to join from */
  from: string;
  /** Local field to match on */
  localField: string;
  /** Foreign field to match on */
  foreignField: string;
  /** Alias for the joined data (defaults to the lookup key) */
  as?: string;
  /** Return a single object instead of array (default: false) */
  single?: boolean;
  /** Field selection on the joined collection */
  select?: string | Record<string, 0 | 1>;
}

/**
 * Mongoose-compatible populate option for advanced field selection.
 *
 * @example
 * ```typescript
 * // URL: ?populate[author][select]=name,email
 * // Generates: { path: 'author', select: 'name email' }
 * ```
 */
export interface PopulateOption {
  /** Field path to populate */
  path: string;
  /** Fields to select (space-separated) */
  select?: string;
  /** Filter conditions for populated documents */
  match?: Record<string, unknown>;
  /** Query options (limit, sort, skip) */
  options?: {
    limit?: number;
    sort?: Record<string, 1 | -1>;
    skip?: number;
  };
  /** Nested populate configuration */
  populate?: PopulateOption;
}

/**
 * Parsed query result from QueryParser. The index signature lets custom
 * parsers (MongoKit, PrismaKit) add fields without breaking Arc's types.
 */
export interface ParsedQuery {
  filters?: Record<string, unknown>;
  limit?: number;
  sort?: string | Record<string, 1 | -1>;
  populate?: string | string[] | Record<string, unknown>;
  populateOptions?: PopulateOption[];
  lookups?: LookupOption[];
  search?: string;
  page?: number;
  after?: string;
  select?: string | string[] | Record<string, 0 | 1>;
  [key: string]: unknown;
}

/**
 * Query Parser interface. Implement to create custom query parsers.
 *
 * @example MongoKit
 * ```typescript
 * import { QueryParser } from '@classytic/mongokit';
 * const queryParser = new QueryParser();
 * ```
 */
export interface QueryParserInterface {
  parse(query: Record<string, unknown> | null | undefined): ParsedQuery;

  /** Optional: Export OpenAPI schema for query parameters. */
  getQuerySchema?(): {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };

  /**
   * Optional: Allowed filter fields whitelist. MCP auto-derives
   * `filterableFields` from this if `schemaOptions.filterableFields`
   * is not explicitly configured.
   */
  allowedFilterFields?: readonly string[];

  /**
   * Optional: Allowed filter operators whitelist. Used by MCP to enrich
   * list-tool descriptions. Values are human-readable keys: 'eq', 'ne',
   * 'gt', 'gte', 'lt', 'lte', 'in', 'nin', etc.
   */
  allowedOperators?: readonly string[];

  /**
   * Optional: Allowed sort fields whitelist. Used by MCP to describe
   * available sort options in list-tool descriptions.
   */
  allowedSortFields?: readonly string[];
}

/** Ownership-check config used by `ownedByUser` preset / middleware. */
export interface OwnershipCheck {
  field: string;
  userField?: string;
}

/** Service-layer context — passed to repository / service calls. */
export interface ServiceContext {
  user?: unknown;
  requestId?: string;
  /** Field projection for responses */
  select?: string[] | Record<string, 0 | 1>;
  /** Relations to populate */
  populate?: string | string[];
  /** Return plain objects */
  lean?: boolean;
}
