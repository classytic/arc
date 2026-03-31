/**
 * Arc Framework Constants — Single Source of Truth
 *
 * Every default value, magic string, and framework constant lives here.
 * Import from this module instead of hard-coding values inline.
 *
 * All exported values are deeply frozen (Object.freeze) to prevent
 * accidental mutation at runtime — inspired by Go's const blocks
 * and Rust's immutable-by-default philosophy.
 */

// ============================================================================
// CRUD Operations
// ============================================================================

/** Standard CRUD operation names */
export const CRUD_OPERATIONS = Object.freeze([
  "list",
  "get",
  "create",
  "update",
  "delete",
] as const);
export type CrudOperation = (typeof CRUD_OPERATIONS)[number];

/** Mutation operations that emit events */
export const MUTATION_OPERATIONS = Object.freeze(["create", "update", "delete"] as const);
export type MutationOperation = (typeof MUTATION_OPERATIONS)[number];

// ============================================================================
// Hook Phases
// ============================================================================

/** Lifecycle hook phases */
export const HOOK_PHASES = Object.freeze(["before", "around", "after"] as const);
export type HookPhase = (typeof HOOK_PHASES)[number];

/** Hook operations (superset of CRUD — includes 'read' alias for 'get') */
export const HOOK_OPERATIONS = Object.freeze([
  "create",
  "update",
  "delete",
  "read",
  "list",
] as const);
export type HookOperation = (typeof HOOK_OPERATIONS)[number];

// ============================================================================
// Pagination & Query Defaults
// ============================================================================

/** Default items per page */
export const DEFAULT_LIMIT = 20 as const;

/** Maximum items per page (framework-wide ceiling) */
export const DEFAULT_MAX_LIMIT = 1000 as const;

/** Default sort field (descending creation date) */
export const DEFAULT_SORT = "-createdAt" as const;

// ============================================================================
// Field & Schema Defaults
// ============================================================================

/** Default primary key field name */
export const DEFAULT_ID_FIELD = "_id" as const;

/** Default multi-tenant scoping field */
export const DEFAULT_TENANT_FIELD = "organizationId" as const;

/** Default HTTP method for update routes */
export const DEFAULT_UPDATE_METHOD = "PATCH" as const;

/** System-managed fields that cannot be set via request body */
export const SYSTEM_FIELDS = Object.freeze([
  "_id",
  "__v",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

// ============================================================================
// Security Limits
// ============================================================================

/** Maximum regex pattern length (ReDoS mitigation) */
export const MAX_REGEX_LENGTH = 200 as const;

/** Maximum search query length */
export const MAX_SEARCH_LENGTH = 200 as const;

/** Maximum filter nesting depth (prevents filter bombs) */
export const MAX_FILTER_DEPTH = 10 as const;

// ============================================================================
// Reserved Query Parameters
// ============================================================================

/**
 * Query parameters consumed by the framework — never treated as filters.
 * Shared by all query parsers (Arc built-in, Prisma, custom).
 */
export const RESERVED_QUERY_PARAMS = Object.freeze(
  new Set([
    "page",
    "limit",
    "sort",
    "populate",
    "search",
    "select",
    "after",
    "cursor",
    "lean",
    "_policyFilters",
  ]),
);
