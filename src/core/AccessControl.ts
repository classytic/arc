/**
 * AccessControl - Composable access control logic extracted from BaseController.
 *
 * Handles ID filtering, policy filter checking, org/tenant scope validation,
 * ownership verification, and fetch-with-access-control patterns.
 *
 * Designed to be used standalone or composed into controllers.
 */

import type {
  AnyRecord,
  ArcInternalMetadata,
  IRequestContext,
  RequestContext,
} from '../types/index.js';
import { isElevated, isMember, getOrgId as getOrgIdFromScope } from '../scope/types.js';
import { MAX_REGEX_LENGTH } from '../constants.js';

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
  getById(id: string, options?: unknown): Promise<unknown>;
  getOne?: (filter: AnyRecord, options?: unknown) => Promise<unknown>;
}

// ============================================================================
// AccessControl Class
// ============================================================================

export class AccessControl {
  private readonly tenantField: string | false;
  private readonly idField: string;
  private readonly _adapterMatchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;

  /** Patterns that indicate dangerous regex (nested quantifiers, excessive backtracking).
   *  Uses [^...] character classes instead of .+ to avoid backtracking in the detector itself. */
  private static readonly DANGEROUS_REGEX = /(\{[0-9]+,\}[^{]*\{[0-9]+,\})|(\+[^+]*\+)|(\*[^*]*\*)|(\.\*){3,}|\\1/;

  /** Forbidden paths that could lead to prototype pollution */
  private static readonly FORBIDDEN_PATHS = ['__proto__', 'constructor', 'prototype'];

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
   * Check if item matches policy filters (for get/update/delete operations)
   * Validates that fetched item satisfies all policy constraints
   *
   * Delegates to adapter-provided matchesFilter if available (for SQL, etc.),
   * otherwise falls back to built-in MongoDB-style matching.
   */
  checkPolicyFilters(item: AnyRecord, req: IRequestContext): boolean {
    // Policy filters are set by permission middleware via req.metadata._policyFilters
    const arcContext = this._meta(req);
    const policyFilters = arcContext?._policyFilters;
    if (!policyFilters) return true;

    // Prefer adapter-provided matching (supports SQL, Prisma, etc.)
    if (this._adapterMatchesFilter) {
      return this._adapterMatchesFilter(item, policyFilters);
    }

    // Fallback: built-in MongoDB-style matching
    return this.defaultMatchesPolicyFilters(item, policyFilters);
  }

  /**
   * Check org/tenant scope for a document — uses configurable tenantField.
   *
   * SECURITY: When org scope is active (orgId present), documents that are
   * missing the tenant field are DENIED by default. This prevents legacy or
   * unscoped records from leaking across tenants.
   */
  checkOrgScope(item: AnyRecord | null, arcContext: ArcInternalMetadata | RequestContext | undefined): boolean {
    // Platform-universal resources (tenantField: false) skip org scope check entirely
    if (!this.tenantField) return true;
    const scope = (arcContext as ArcInternalMetadata | undefined)?._scope;
    const orgId = scope ? getOrgIdFromScope(scope) : undefined;
    if (!item || !orgId) return true;
    // Elevated scope without org → skip check (admin viewing all)
    if (scope && isElevated(scope) && !orgId) return true;
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
    queryOptions?: unknown,
  ): Promise<TDoc | null> {
    const compoundFilter = this.buildIdFilter(id, req);
    const hasCompoundFilters = Object.keys(compoundFilter).length > 1;

    try {
      if (hasCompoundFilters && typeof repository.getOne === 'function') {
        return await repository.getOne(compoundFilter, queryOptions) as TDoc | null;
      }

      // Fallback: getById + post-hoc security checks
      const item = await repository.getById(id, queryOptions) as TDoc | null;
      if (!item) return null;

      const arcContext = this._meta(req);
      if (!this.checkOrgScope(item as AnyRecord, arcContext) || !this.checkPolicyFilters(item as AnyRecord, req)) {
        return null;
      }

      return item;
    } catch (error: unknown) {
      // Repositories (MongoKit, etc.) may throw "not found" errors instead of returning null
      if (error instanceof Error && error.message?.includes('not found')) {
        return null;
      }
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

  /**
   * Check if a value matches a MongoDB query operator
   */
  private matchesOperator(itemValue: unknown, operator: string, filterValue: unknown): boolean {
    const equalsByValue = (a: unknown, b: unknown): boolean => String(a) === String(b);

    switch (operator) {
      case '$eq':
        return equalsByValue(itemValue, filterValue);
      case '$ne':
        return !equalsByValue(itemValue, filterValue);
      case '$gt':
        return typeof itemValue === 'number' && typeof filterValue === 'number' && itemValue > filterValue;
      case '$gte':
        return typeof itemValue === 'number' && typeof filterValue === 'number' && itemValue >= filterValue;
      case '$lt':
        return typeof itemValue === 'number' && typeof filterValue === 'number' && itemValue < filterValue;
      case '$lte':
        return typeof itemValue === 'number' && typeof filterValue === 'number' && itemValue <= filterValue;
      case '$in':
        if (!Array.isArray(filterValue)) return false;
        if (Array.isArray(itemValue)) {
          return itemValue.some((v) => filterValue.some((fv) => equalsByValue(v, fv)));
        }
        return filterValue.some((fv) => equalsByValue(itemValue, fv));
      case '$nin':
        if (!Array.isArray(filterValue)) return false;
        if (Array.isArray(itemValue)) {
          return itemValue.every((v) => filterValue.every((fv) => !equalsByValue(v, fv)));
        }
        return filterValue.every((fv) => !equalsByValue(itemValue, fv));
      case '$exists':
        return filterValue ? itemValue !== undefined : itemValue === undefined;
      case '$regex':
        if (typeof itemValue === 'string' && (typeof filterValue === 'string' || filterValue instanceof RegExp)) {
          const regex = typeof filterValue === 'string'
            ? AccessControl.safeRegex(filterValue)
            : filterValue;
          return regex !== null && regex.test(itemValue);
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * Check if item matches a single filter condition
   * Supports nested paths (e.g., "owner.id", "metadata.status")
   */
  private matchesFilter(item: AnyRecord, key: string, filterValue: unknown): boolean {
    // Support nested paths with dot notation
    const itemValue = key.includes('.') ? this.getNestedValue(item, key) : item[key];

    // Handle MongoDB query operators
    if (filterValue && typeof filterValue === 'object' && !Array.isArray(filterValue)) {
      const operators = Object.keys(filterValue);
      // Check if this is an operator object (e.g., { $in: [...], $ne: ... })
      if (operators.some(op => op.startsWith('$'))) {
        for (const [operator, opValue] of Object.entries(filterValue as AnyRecord)) {
          if (!this.matchesOperator(itemValue, operator, opValue)) {
            return false;
          }
        }
        return true;
      }
    }

    // MongoDB implicit array matching: { field: value } matches if field is
    // an array containing value. Check element-wise before falling back to
    // simple equality.
    if (Array.isArray(itemValue)) {
      return itemValue.some(v => String(v) === String(filterValue));
    }

    // Simple equality check - convert to strings for ObjectId compatibility
    // ObjectId instances are only === if they're the same reference,
    // so we need to compare string representations for value equality
    return String(itemValue) === String(filterValue);
  }

  /**
   * Built-in MongoDB-style policy filter matching.
   * Supports: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, $regex, $and, $or
   */
  private defaultMatchesPolicyFilters(item: AnyRecord, policyFilters: AnyRecord): boolean {
    // Check $and operator — all conditions must match
    if (policyFilters.$and && Array.isArray(policyFilters.$and)) {
      const andMatches = policyFilters.$and.every((condition: AnyRecord) => {
        return Object.entries(condition).every(([key, value]) => {
          return this.matchesFilter(item, key, value);
        });
      });
      if (!andMatches) return false;
    }

    // Check $or operator — at least one condition must match
    if (policyFilters.$or && Array.isArray(policyFilters.$or)) {
      const orMatches = policyFilters.$or.some((condition: AnyRecord) => {
        return Object.entries(condition).every(([key, value]) => {
          return this.matchesFilter(item, key, value);
        });
      });
      if (!orMatches) return false;
    }

    // Check each non-logical sibling constraint (always evaluated,
    // even when $and/$or are present on the same filter object)
    for (const [key, value] of Object.entries(policyFilters)) {
      if (key.startsWith('$')) continue;

      if (!this.matchesFilter(item, key, value)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get nested value from object using dot notation (e.g., "owner.id")
   * Security: Validates path against forbidden patterns to prevent prototype pollution
   */
  private getNestedValue(obj: AnyRecord, path: string): unknown {
    // Security: Prevent prototype pollution attacks
    if (AccessControl.FORBIDDEN_PATHS.some(p => path.toLowerCase().includes(p))) {
      return undefined;
    }

    const keys = path.split('.');
    let value: unknown = obj;

    for (const key of keys) {
      if (value == null) return undefined;
      // Security: Block forbidden keys at each level
      if (AccessControl.FORBIDDEN_PATHS.includes(key.toLowerCase())) {
        return undefined;
      }
      value = (value as AnyRecord)[key];
    }

    return value;
  }

  // ============================================================================
  // Static Helpers
  // ============================================================================

  /**
   * Create a safe RegExp from a string, guarding against ReDoS.
   * Returns null if the pattern is invalid or dangerous.
   */
  private static safeRegex(pattern: string): RegExp | null {
    if (pattern.length > MAX_REGEX_LENGTH) return null;
    if (AccessControl.DANGEROUS_REGEX.test(pattern)) return null;
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }
}
