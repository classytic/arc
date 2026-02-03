/**
 * Base Controller - Framework-Agnostic CRUD Operations
 *
 * Implements IController interface for framework portability.
 * Works with Fastify, Express, Next.js, or any framework via adapter pattern.
 *
 * @example
 * import { BaseController } from '@classytic/arc';
 *
 * // Use Arc's default query parser (works out of the box)
 * class ProductController extends BaseController {
 *   constructor(repository: CrudRepository) {
 *     super(repository);
 *   }
 * }
 *
 * // Or use MongoKit's parser for advanced MongoDB features ($lookup, aggregations)
 * import { QueryParser } from '@classytic/mongokit';
 * defineResource({
 *   name: 'product',
 *   queryParser: new QueryParser(),
 *   // ...
 * });
 *
 * // Or use a custom parser for SQL databases
 * defineResource({
 *   name: 'user',
 *   queryParser: new PgQueryParser(),
 *   // ...
 * });
 */

import type {
  AnyRecord,
  ControllerQueryOptions,
  IController,
  IControllerResponse,
  IRequestContext,
  PaginatedResult,
  PaginationParams,
  ParsedQuery,
  QueryParserInterface,
  RequestContext,
  RouteSchemaOptions,
  ServiceContext,
  UserLike,
} from '../types/index.js';
import { getUserId } from '../types/index.js';
import { hookSystem, type HookSystem } from '../hooks/HookSystem.js';
import { ArcQueryParser } from '../utils/queryParser.js';

// Re-export ParsedQuery for backwards compatibility
export type { ParsedQuery } from '../types/index.js';

// ============================================================================
// Flexible Repository Type
// ============================================================================

/**
 * Flexible repository interface that accepts any repository shape
 * Core CRUD methods use flexible signatures to work with any implementation
 * Custom methods can be added via the index signature
 *
 * @example
 * // MongoKit repository with custom methods
 * interface MyRepository extends FlexibleRepository {
 *   findByEmail(email: string): Promise<User>;
 *   customMethod(): Promise<void>;
 * }
 */
export interface FlexibleRepository {
  // Core CRUD methods with flexible signatures
  getAll(...args: any[]): Promise<any>;
  getById(...args: any[]): Promise<any>;
  create(...args: any[]): Promise<any>;
  update(...args: any[]): Promise<any>;
  delete(...args: any[]): Promise<any>;

  // Allow any custom methods
  [key: string]: any;
}

// ============================================================================
// Default Query Parser
// ============================================================================

const defaultParser = new ArcQueryParser();

function getDefaultQueryParser(): QueryParserInterface {
  return defaultParser;
}

// ============================================================================
// Controller Options
// ============================================================================

export interface BaseControllerOptions {
  /** Schema options for field sanitization */
  schemaOptions?: RouteSchemaOptions;
  /**
   * Query parser instance
   * Default: Arc built-in query parser (adapter-agnostic).
   * You can swap in MongoKit QueryParser, pgkit parser, etc.
   */
  queryParser?: QueryParserInterface;
  /** Maximum limit for pagination (default: 100) */
  maxLimit?: number;
  /** Default limit for pagination (default: 20) */
  defaultLimit?: number;
  /** Default sort field (default: '-createdAt') */
  defaultSort?: string;
  /** Resource name for hook execution (e.g., 'product' → 'product.created') */
  resourceName?: string;
  /** Disable automatic event emission (default: false) */
  disableEvents?: boolean;
}

// ============================================================================
// Base Controller - Implements IController<TDoc>
// ============================================================================

/**
 * Framework-agnostic base controller implementing MongoKit's IController
 *
 * @template TDoc - The document type
 * @template TRepository - The repository type (defaults to CrudRepository<TDoc>, preserves custom methods when specified)
 *
 * Use with Fastify adapter for Fastify integration (see createFastifyAdapter in createCrudRouter)
 *
 * @example
 * // Without custom repository type (backward compatible)
 * class SimpleController extends BaseController<Product> {
 *   constructor(repository: CrudRepository<Product>) {
 *     super(repository);
 *   }
 * }
 *
 * @example
 * // With custom repository type (type-safe access to custom methods)
 * class ProductController extends BaseController<Product, ProductRepository> {
 *   constructor(repository: ProductRepository) {
 *     super(repository);
 *   }
 *
 *   async customMethod(context: IRequestContext) {
 *     // TypeScript knows about ProductRepository's custom methods
 *     return await this.repository.findByCategory(...);
 *   }
 * }
 */
export class BaseController<
  TDoc = AnyRecord,
  TRepository extends FlexibleRepository = FlexibleRepository
> implements IController<TDoc> {
  protected repository: TRepository;
  protected schemaOptions: RouteSchemaOptions;
  protected queryParser: QueryParserInterface;
  protected maxLimit: number;
  protected defaultLimit: number;
  protected defaultSort: string;
  protected resourceName?: string;
  protected disableEvents: boolean;

  /** Preset field names for dynamic param reading */
  protected _presetFields: {
    slugField?: string;
    parentField?: string;
  } = {};

  constructor(repository: TRepository, options: BaseControllerOptions = {}) {
    this.repository = repository;
    this.schemaOptions = options.schemaOptions ?? {};
    // Auto-detect MongoKit QueryParser if available
    this.queryParser = options.queryParser ?? getDefaultQueryParser();
    this.maxLimit = options.maxLimit ?? 100;
    this.defaultLimit = options.defaultLimit ?? 20;
    this.defaultSort = options.defaultSort ?? '-createdAt';
    this.resourceName = options.resourceName;
    this.disableEvents = options.disableEvents ?? false;

    // Bind CRUD methods
    this.list = this.list.bind(this);
    this.get = this.get.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
  }

  /**
   * Inject resource options from defineResource
   */
  _setResourceOptions(options: {
    schemaOptions?: RouteSchemaOptions;
    presetFields?: { slugField?: string; parentField?: string };
    resourceName?: string;
    queryParser?: QueryParserInterface;
  }): void {
    if (options.schemaOptions) {
      this.schemaOptions = { ...this.schemaOptions, ...options.schemaOptions };
    }
    if (options.presetFields) {
      this._presetFields = { ...this._presetFields, ...options.presetFields };
    }
    if (options.resourceName) {
      this.resourceName = options.resourceName;
    }
    if (options.queryParser) {
      this.queryParser = options.queryParser;
    }
  }

  // ============================================================================
  // Context & Query Parsing
  // ============================================================================

  /**
   * Build service context from IRequestContext
   */
  protected _buildContext(req: IRequestContext): ServiceContext {
    const parsed = this.queryParser.parse(req.query);
    const arcContext = req.metadata as RequestContext | undefined;

    // Use parsed.select if available, otherwise fall back to raw query string
    const selectString = this._selectToString(parsed.select) ?? (req.query?.select as string);
    const sanitizedSelect = this._sanitizeSelect(selectString, this.schemaOptions);

    return {
      user: req.user as UserLike | undefined,
      organizationId: arcContext?.organizationId ?? req.organizationId ?? undefined,
      select: sanitizedSelect ? sanitizedSelect.split(/\s+/) : undefined,
      populate: this._sanitizePopulate(parsed.populate, this.schemaOptions),
      lean: this._parseLean(req.query?.lean),
    };
  }

  /**
   * Parse query into QueryOptions using queryParser
   */
  protected _parseQueryOptions(req: IRequestContext): ControllerQueryOptions {
    const parsed = this.queryParser.parse(req.query);
    const arcContext = req.metadata as RequestContext | undefined;

    // Remove internal params from filters
    delete (parsed.filters as AnyRecord)._policyFilters;

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
    const selectString = this._selectToString(parsed.select) ?? (req.query?.select as string);

    return {
      page,
      limit,
      sort: sortString,
      select: this._sanitizeSelect(selectString, this.schemaOptions),
      populate: this._sanitizePopulate(parsed.populate, this.schemaOptions),
      // Advanced populate options from MongoKit QueryParser (takes precedence over simple populate)
      populateOptions: parsed.populateOptions,
      filters: parsed.filters as AnyRecord,
      // MongoKit features
      search: parsed.search,
      after: parsed.after,
      user: req.user as UserLike | undefined,
      organizationId: arcContext?.organizationId ?? req.organizationId,
      context: arcContext,
    };
  }

  /**
   * Apply org and policy filters
   */
  protected _applyFilters(options: ControllerQueryOptions, req: IRequestContext): ControllerQueryOptions {
    const filters = { ...(options.filters as AnyRecord) };
    const arcContext = req.metadata as RequestContext | undefined;

    // Policy filters (set by permission middleware via req.metadata._policyFilters)
    const policyFilters = (arcContext as AnyRecord | undefined)?._policyFilters as AnyRecord | undefined;
    if (policyFilters) {
      Object.assign(filters, policyFilters);
    }

    // Org scope
    const orgId = arcContext?.organizationId ?? req.organizationId;
    if (orgId) {
      filters.organizationId = orgId;
    }

    return { ...options, filters };
  }

  /**
   * Build filter for single-item operations (get/update/delete)
   * Combines ID filter with policy/org filters for proper security enforcement
   */
  protected _buildIdFilter(id: string, req: IRequestContext): AnyRecord {
    const filter: AnyRecord = { _id: id };
    const arcContext = req.metadata as RequestContext | undefined;

    // Apply policy filters (set by permission middleware via req.metadata._policyFilters)
    const policyFilters = (arcContext as AnyRecord | undefined)?._policyFilters as AnyRecord | undefined;
    if (policyFilters) {
      Object.assign(filter, policyFilters);
    }

    // Apply org scope filter
    const orgId = arcContext?.organizationId ?? req.organizationId;
    if (orgId) {
      filter.organizationId = orgId;
    }

    return filter;
  }

  /**
   * Check if a value matches a MongoDB query operator
   */
  protected _matchesOperator(itemValue: unknown, operator: string, filterValue: unknown): boolean {
    switch (operator) {
      case '$eq':
        return itemValue === filterValue;
      case '$ne':
        return itemValue !== filterValue;
      case '$gt':
        return typeof itemValue === 'number' && typeof filterValue === 'number' && itemValue > filterValue;
      case '$gte':
        return typeof itemValue === 'number' && typeof filterValue === 'number' && itemValue >= filterValue;
      case '$lt':
        return typeof itemValue === 'number' && typeof filterValue === 'number' && itemValue < filterValue;
      case '$lte':
        return typeof itemValue === 'number' && typeof filterValue === 'number' && itemValue <= filterValue;
      case '$in':
        return Array.isArray(filterValue) && filterValue.includes(itemValue);
      case '$nin':
        return Array.isArray(filterValue) && !filterValue.includes(itemValue);
      case '$exists':
        return filterValue ? itemValue !== undefined : itemValue === undefined;
      case '$regex':
        if (typeof itemValue === 'string' && (typeof filterValue === 'string' || filterValue instanceof RegExp)) {
          const regex = typeof filterValue === 'string' ? new RegExp(filterValue) : filterValue;
          return regex.test(itemValue);
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * Forbidden paths that could lead to prototype pollution
   */
  private static readonly FORBIDDEN_PATHS = ['__proto__', 'constructor', 'prototype'];

  /**
   * Get nested value from object using dot notation (e.g., "owner.id")
   * Security: Validates path against forbidden patterns to prevent prototype pollution
   */
  protected _getNestedValue(obj: AnyRecord, path: string): unknown {
    // Security: Prevent prototype pollution attacks
    if (BaseController.FORBIDDEN_PATHS.some(p => path.toLowerCase().includes(p))) {
      return undefined;
    }

    const keys = path.split('.');
    let value: any = obj;

    for (const key of keys) {
      if (value == null) return undefined;
      // Security: Block forbidden keys at each level
      if (BaseController.FORBIDDEN_PATHS.includes(key.toLowerCase())) {
        return undefined;
      }
      value = value[key];
    }

    return value;
  }

  /**
   * Check if item matches a single filter condition
   * Supports nested paths (e.g., "owner.id", "metadata.status")
   */
  protected _matchesFilter(item: AnyRecord, key: string, filterValue: unknown): boolean {
    // Support nested paths with dot notation
    const itemValue = key.includes('.') ? this._getNestedValue(item, key) : item[key];

    // Handle MongoDB query operators
    if (filterValue && typeof filterValue === 'object' && !Array.isArray(filterValue)) {
      const operators = Object.keys(filterValue);
      // Check if this is an operator object (e.g., { $in: [...], $ne: ... })
      if (operators.some(op => op.startsWith('$'))) {
        for (const [operator, opValue] of Object.entries(filterValue as AnyRecord)) {
          if (!this._matchesOperator(itemValue, operator, opValue)) {
            return false;
          }
        }
        return true;
      }
    }

    // Simple equality check - convert to strings for ObjectId compatibility
    // ObjectId instances are only === if they're the same reference,
    // so we need to compare string representations for value equality
    return String(itemValue) === String(filterValue);
  }

  /**
   * Check if item matches policy filters (for get/update/delete operations)
   * Validates that fetched item satisfies all policy constraints
   * Supports MongoDB query operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, $regex, $and, $or
   */
  protected _checkPolicyFilters(item: AnyRecord, req: IRequestContext): boolean {
    // Policy filters are set by permission middleware via req.metadata._policyFilters
    const arcContext = req.metadata as AnyRecord | undefined;
    const policyFilters = arcContext?._policyFilters as AnyRecord | undefined;
    if (!policyFilters) return true;

    // Handle $and operator
    if (policyFilters.$and && Array.isArray(policyFilters.$and)) {
      return policyFilters.$and.every((condition: AnyRecord) => {
        return Object.entries(condition).every(([key, value]) => {
          return this._matchesFilter(item, key, value);
        });
      });
    }

    // Handle $or operator
    if (policyFilters.$or && Array.isArray(policyFilters.$or)) {
      return policyFilters.$or.some((condition: AnyRecord) => {
        return Object.entries(condition).every(([key, value]) => {
          return this._matchesFilter(item, key, value);
        });
      });
    }

    // Check each policy filter constraint
    for (const [key, value] of Object.entries(policyFilters)) {
      // Skip MongoDB logical operators (already handled above)
      if (key.startsWith('$')) continue;

      if (!this._matchesFilter(item, key, value)) {
        return false;
      }
    }

    return true;
  }

  // ============================================================================
  // Sanitization Helpers
  // ============================================================================

  /** Parse lean option (default: true for performance) */
  protected _parseLean(leanValue: unknown): boolean {
    if (typeof leanValue === 'boolean') return leanValue;
    if (typeof leanValue === 'string') return leanValue.toLowerCase() !== 'false';
    return true;
  }

  /** Get blocked fields from schema options */
  protected _getBlockedFields(schemaOptions: RouteSchemaOptions): string[] {
    const fieldRules = schemaOptions.fieldRules ?? {};
    return Object.entries(fieldRules)
      .filter(([, rules]) => rules.systemManaged || rules.hidden)
      .map(([field]) => field);
  }

  /**
   * Convert parsed select object to string format
   * Converts { name: 1, email: 1, password: 0 } → 'name email -password'
   */
  protected _selectToString(select: string | string[] | Record<string, 0 | 1> | undefined): string | undefined {
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
  protected _sanitizeSelect(
    select: string | undefined,
    schemaOptions: RouteSchemaOptions
  ): string | undefined {
    if (!select) return undefined;

    const blockedFields = this._getBlockedFields(schemaOptions);
    if (blockedFields.length === 0) return select;

    const fields = select.split(/[\s,]+/).filter(Boolean);
    const sanitized = fields.filter((f) => {
      const fieldName = f.replace(/^-/, '');
      return !blockedFields.includes(fieldName);
    });

    return sanitized.length > 0 ? sanitized.join(' ') : undefined;
  }

  /** Sanitize populate fields */
  protected _sanitizePopulate(
    populate: unknown,
    schemaOptions: RouteSchemaOptions
  ): string[] | undefined {
    if (!populate) return undefined;

    const allowedPopulate = (schemaOptions.query as any)?.allowedPopulate as string[] | undefined;
    const requested = typeof populate === 'string'
      ? populate.split(',').map((p) => p.trim())
      : Array.isArray(populate) ? populate.map(String) : [];

    if (requested.length === 0) return undefined;

    // If no allowlist, allow all (backward compatible)
    if (!allowedPopulate) return requested;

    const sanitized = requested.filter((p) => allowedPopulate.includes(p));
    return sanitized.length > 0 ? sanitized : undefined;
  }

  // ============================================================================
  // Access Control Helpers
  // ============================================================================

  /** Check org scope for a document */
  protected _checkOrgScope(item: AnyRecord | null, arcContext: RequestContext | undefined): boolean {
    if (!item || !arcContext?.organizationId) return true;
    const itemOrgId = (item as { organizationId?: unknown }).organizationId;
    if (!itemOrgId) return true;
    return String(itemOrgId) === String(arcContext.organizationId);
  }

  /** Check ownership for update/delete (ownedByUser preset) */
  protected _checkOwnership(item: AnyRecord | null, req: IRequestContext): boolean {
    // Ownership check would need to be passed via req.metadata
    const ownershipCheck = (req.metadata as any)?._ownershipCheck;
    if (!item || !ownershipCheck) return true;
    const { field, userId } = ownershipCheck;
    const itemOwnerId = item[field];
    if (!itemOwnerId) return true;
    return String(itemOwnerId) === String(userId);
  }

  /**
   * Get hook system from context (instance-scoped) or fall back to global singleton
   * This allows proper isolation when running multiple app instances (e.g., in tests)
   */
  protected _getHooks(req: IRequestContext): HookSystem {
    const arcMeta = (req.metadata as AnyRecord | undefined)?.arc as AnyRecord | undefined;
    return (arcMeta?.hooks as HookSystem | undefined) ?? hookSystem;
  }

  // ============================================================================
  // IController Implementation - CRUD Operations
  // ============================================================================

  /**
   * List resources with filtering, pagination, sorting
   * Implements IController.list()
   */
  async list(req: IRequestContext): Promise<IControllerResponse<PaginatedResult<TDoc>>> {
    const options = this._parseQueryOptions(req);
    const filteredOptions = this._applyFilters(options, req);

    const result = await this.repository.getAll(filteredOptions as PaginationParams<TDoc>);

    // Handle array result (non-paginated) - convert to paginated format
    if (Array.isArray(result)) {
      return {
        success: true,
        data: {
          docs: result as TDoc[],
          page: 1,
          limit: result.length,
          total: result.length,
          pages: 1,
          hasNext: false,
          hasPrev: false,
        },
        status: 200,
      };
    }

    // MongoKit pagination result
    return {
      success: true,
      data: result as PaginatedResult<TDoc>,
      status: 200,
    };
  }

  /**
   * Get single resource by ID
   * Implements IController.get()
   */
  async get(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const id = req.params.id;
    if (!id) {
      return {
        success: false,
        error: 'ID parameter is required',
        status: 400,
      };
    }

    const options = this._parseQueryOptions(req);
    const arcContext = req.metadata as RequestContext | undefined;

    try {
      const item = await this.repository.getById(id, options);

      // Security checks - all must pass or return 404 (don't leak existence)
      const hasItem = !!item;
      const orgScopeOk = this._checkOrgScope(item as AnyRecord, arcContext);
      const policyFiltersOk = this._checkPolicyFilters(item as AnyRecord, req);

      if (!hasItem || !orgScopeOk || !policyFiltersOk) {
        return {
          success: false,
          error: 'Resource not found',
          status: 404,
        };
      }

      return {
        success: true,
        data: item as TDoc,
        status: 200,
      };
    } catch (error: unknown) {
      // MongoKit throws "Document not found" error
      if (error instanceof Error && error.message?.includes('not found')) {
        return {
          success: false,
          error: 'Resource not found',
          status: 404,
        };
      }
      throw error;
    }
  }

  /**
   * Create new resource
   * Implements IController.create()
   */
  async create(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const data: AnyRecord = { ...(req.body as AnyRecord) };
    const arcContext = req.metadata as RequestContext | undefined;

    // Inject org scope
    if (arcContext?.organizationId) {
      data.organizationId = arcContext.organizationId;
    }

    // Inject user reference
    const userId = getUserId(req.user as UserLike | undefined);
    if (userId) {
      data.createdBy = userId;
    }

    // Execute beforeCreate hooks (use instance-scoped hooks if available)
    const hooks = this._getHooks(req);
    const user = req.user as UserLike | undefined;
    let processedData = data;
    if (this.resourceName) {
      processedData = await hooks.executeBefore(this.resourceName, 'create', data, {
        user,
        context: arcContext,
      });
    }

    const item = await this.repository.create(processedData as Partial<TDoc>, {
      user,
      context: arcContext,
    });

    // Execute afterCreate hooks
    if (this.resourceName) {
      await hooks.executeAfter(this.resourceName, 'create', item as AnyRecord, {
        user,
        context: arcContext,
      });
    }

    return {
      success: true,
      data: item as TDoc,
      status: 201,
      meta: { message: 'Created successfully' },
    };
  }

  /**
   * Update existing resource
   * Implements IController.update()
   */
  async update(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const id = req.params.id;
    if (!id) {
      return {
        success: false,
        error: 'ID parameter is required',
        status: 400,
      };
    }

    const data: AnyRecord = { ...(req.body as AnyRecord) };
    const arcContext = req.metadata as RequestContext | undefined;
    const user = req.user as UserLike | undefined;

    // Inject updater reference
    const userId = getUserId(user);
    if (userId) {
      data.updatedBy = userId;
    }

    // Fetch existing for scope/ownership/policy checks
    const existing = await this.repository.getById(id);
    if (!existing) {
      return {
        success: false,
        error: 'Resource not found',
        status: 404,
      };
    }

    // Security checks - org and policy filters return 404 (don't leak existence)
    if (!this._checkOrgScope(existing as AnyRecord, arcContext) || !this._checkPolicyFilters(existing as AnyRecord, req)) {
      return {
        success: false,
        error: 'Resource not found',
        status: 404,
      };
    }

    // Ownership check returns 403 (user knows it exists but can't modify)
    if (!this._checkOwnership(existing as AnyRecord, req)) {
      return {
        success: false,
        error: 'You do not have permission to modify this resource',
        details: { code: 'OWNERSHIP_DENIED' },
        status: 403,
      };
    }

    // Execute beforeUpdate hooks (use instance-scoped hooks if available)
    const hooks = this._getHooks(req);
    let processedData = data;
    if (this.resourceName) {
      processedData = await hooks.executeBefore(this.resourceName, 'update', data, {
        user,
        context: arcContext,
        meta: { id, existing },
      });
    }

    const item = await this.repository.update(id, processedData as Partial<TDoc>, {
      user,
      context: arcContext,
    });

    if (!item) {
      return {
        success: false,
        error: 'Resource not found',
        status: 404,
      };
    }

    // Execute afterUpdate hooks
    if (this.resourceName) {
      await hooks.executeAfter(this.resourceName, 'update', item as AnyRecord, {
        user,
        context: arcContext,
        meta: { id, existing },
      });
    }

    return {
      success: true,
      data: item as TDoc,
      status: 200,
      meta: { message: 'Updated successfully' },
    };
  }

  /**
   * Delete resource
   * Implements IController.delete()
   */
  async delete(req: IRequestContext): Promise<IControllerResponse<{ message: string }>> {
    const id = req.params.id;
    if (!id) {
      return {
        success: false,
        error: 'ID parameter is required',
        status: 400,
      };
    }

    const arcContext = req.metadata as RequestContext | undefined;
    const user = req.user as UserLike | undefined;

    const existing = await this.repository.getById(id);
    if (!existing) {
      return {
        success: false,
        error: 'Resource not found',
        status: 404,
      };
    }

    // Security checks - org and policy filters return 404 (don't leak existence)
    if (!this._checkOrgScope(existing as AnyRecord, arcContext) || !this._checkPolicyFilters(existing as AnyRecord, req)) {
      return {
        success: false,
        error: 'Resource not found',
        status: 404,
      };
    }

    // Ownership check returns 403 (user knows it exists but can't delete)
    if (!this._checkOwnership(existing as AnyRecord, req)) {
      return {
        success: false,
        error: 'You do not have permission to delete this resource',
        details: { code: 'OWNERSHIP_DENIED' },
        status: 403,
      };
    }

    // Execute beforeDelete hooks (use instance-scoped hooks if available)
    const hooks = this._getHooks(req);
    if (this.resourceName) {
      await hooks.executeBefore(this.resourceName, 'delete', existing as AnyRecord, {
        user,
        context: arcContext,
        meta: { id },
      });
    }

    const result = await this.repository.delete(id, {
      user,
      context: arcContext,
    });

    // Handle both MongoKit's { success, message } and simple boolean returns
    const deleteSuccess = typeof result === 'object' ? result?.success : result;
    if (!deleteSuccess) {
      return {
        success: false,
        error: 'Resource not found',
        status: 404,
      };
    }

    // Execute afterDelete hooks
    if (this.resourceName) {
      await hooks.executeAfter(this.resourceName, 'delete', existing as AnyRecord, {
        user,
        context: arcContext,
        meta: { id },
      });
    }

    return {
      success: true,
      data: { message: 'Deleted successfully' },
      status: 200,
    };
  }

  // ============================================================================
  // Preset Methods (framework-agnostic versions)
  // ============================================================================

  /** Get resource by slug (slugLookup preset) */
  async getBySlug(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const repo = this.repository as any;
    if (!repo.getBySlug) {
      return {
        success: false,
        error: 'Slug lookup not implemented',
        status: 501,
      };
    }

    const slugField = this._presetFields.slugField ?? 'slug';
    const slug = (req.params[slugField] ?? req.params.slug) as string;
    const options = this._parseQueryOptions(req);
    const arcContext = req.metadata as RequestContext | undefined;
    const item = await repo.getBySlug(slug, options);

    if (!item || !this._checkOrgScope(item as AnyRecord, arcContext)) {
      return {
        success: false,
        error: 'Resource not found',
        status: 404,
      };
    }

    return {
      success: true,
      data: item as TDoc,
      status: 200,
    };
  }

  /** Get soft-deleted resources (softDelete preset) */
  async getDeleted(req: IRequestContext): Promise<IControllerResponse<PaginatedResult<TDoc>>> {
    const repo = this.repository as any;
    if (!repo.getDeleted) {
      return {
        success: false,
        error: 'Soft delete not implemented',
        status: 501,
      };
    }

    const options = this._parseQueryOptions(req);
    const filteredOptions = this._applyFilters(options, req);
    const result = await repo.getDeleted(filteredOptions);

    // Handle array result (non-paginated)
    if (Array.isArray(result)) {
      return {
        success: true,
        data: {
          docs: result as TDoc[],
          page: 1,
          limit: result.length,
          total: result.length,
          pages: 1,
          hasNext: false,
          hasPrev: false,
        },
        status: 200,
      };
    }

    // MongoKit pagination result
    return {
      success: true,
      data: result as PaginatedResult<TDoc>,
      status: 200,
    };
  }

  /** Restore soft-deleted resource (softDelete preset) */
  async restore(req: IRequestContext): Promise<IControllerResponse<TDoc>> {
    const repo = this.repository as any;
    if (!repo.restore) {
      return {
        success: false,
        error: 'Restore not implemented',
        status: 501,
      };
    }

    const id = req.params.id;
    if (!id) {
      return {
        success: false,
        error: 'ID parameter is required',
        status: 400,
      };
    }

    const item = await repo.restore(id);

    if (!item) {
      return {
        success: false,
        error: 'Resource not found',
        status: 404,
      };
    }

    return {
      success: true,
      data: item as TDoc,
      status: 200,
      meta: { message: 'Restored successfully' },
    };
  }

  /** Get hierarchical tree (tree preset) */
  async getTree(req: IRequestContext): Promise<IControllerResponse<TDoc[]>> {
    const repo = this.repository as any;
    if (!repo.getTree) {
      return {
        success: false,
        error: 'Tree structure not implemented',
        status: 501,
      };
    }

    const options = this._parseQueryOptions(req);
    const filteredOptions = this._applyFilters(options, req);
    const tree = await repo.getTree(filteredOptions);

    return {
      success: true,
      data: tree as TDoc[],
      status: 200,
    };
  }

  /** Get children of parent (tree preset) */
  async getChildren(req: IRequestContext): Promise<IControllerResponse<TDoc[]>> {
    const repo = this.repository as any;
    if (!repo.getChildren) {
      return {
        success: false,
        error: 'Tree structure not implemented',
        status: 501,
      };
    }

    const parentField = this._presetFields.parentField ?? 'parent';
    const parentId = (req.params[parentField] ?? req.params.parent ?? req.params.id) as string;
    const options = this._parseQueryOptions(req);
    const filteredOptions = this._applyFilters(options, req);
    const children = await repo.getChildren(parentId, filteredOptions);

    return {
      success: true,
      data: children as TDoc[],
      status: 200,
    };
  }
}

export default BaseController;
