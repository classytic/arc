/**
 * Preset Type Interfaces
 *
 * TypeScript interfaces that document the controller methods required by each preset.
 * These interfaces help with type safety when using presets.
 *
 * @example Using with custom controllers
 * ```typescript
 * import { BaseController } from '@classytic/arc';
 * import type { ISoftDeleteController } from '@classytic/arc/presets';
 *
 * class ProductController extends BaseController<Product> implements ISoftDeleteController {
 *   // TypeScript now ensures you have getDeleted() and restore() methods
 * }
 * ```
 */

import type { IRequestContext, IControllerResponse, PaginatedResult } from '../types/index.js';

/**
 * Soft Delete Preset Interface
 *
 * Required when using the `softDelete` preset.
 * BaseController provides default implementations that delegate to repository methods.
 *
 * **Routes Added:**
 * - `GET /deleted` → `getDeleted()`
 * - `POST /:id/restore` → `restore()`
 *
 * **Repository Requirements:**
 * Your repository must implement:
 * - `getDeleted(options): Promise<PaginatedResult<T> | T[]>`
 * - `restore(id): Promise<T | null>`
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'product',
 *   presets: ['softDelete'],
 *   adapter: createMongooseAdapter({
 *     model: ProductModel,
 *     repository: productRepository, // Must implement getDeleted/restore
 *   }),
 * });
 * ```
 */
export interface ISoftDeleteController<TDoc = unknown> {
  /**
   * Get all soft-deleted items
   * Called by: GET /deleted
   */
  getDeleted(req: IRequestContext): Promise<IControllerResponse<PaginatedResult<TDoc>>>;

  /**
   * Restore a soft-deleted item by ID
   * Called by: POST /:id/restore
   */
  restore(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
}

/**
 * Slug Lookup Preset Interface
 *
 * Required when using the `slugLookup` preset.
 * BaseController provides default implementation that delegates to repository.
 *
 * **Routes Added:**
 * - `GET /slug/:slug` → `getBySlug()`
 *
 * **Repository Requirements:**
 * Your repository must implement:
 * - `getBySlug(slug, options): Promise<T | null>`
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'product',
 *   presets: ['slugLookup'],
 *   adapter: createMongooseAdapter({
 *     model: ProductModel,
 *     repository: productRepository, // Must implement getBySlug
 *   }),
 * });
 * ```
 */
export interface ISlugLookupController<TDoc = unknown> {
  /**
   * Get a resource by its slug
   * Called by: GET /slug/:slug
   */
  getBySlug(req: IRequestContext): Promise<IControllerResponse<TDoc>>;
}

/**
 * Tree Preset Interface
 *
 * Required when using the `tree` preset for hierarchical data structures.
 * BaseController provides default implementations that delegate to repository.
 *
 * **Routes Added:**
 * - `GET /tree` → `getTree()`
 * - `GET /:parent/children` → `getChildren()`
 *
 * **Repository Requirements:**
 * Your repository must implement:
 * - `getTree(options): Promise<T[]>`
 * - `getChildren(parentId, options): Promise<T[]>`
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'category',
 *   presets: [{ name: 'tree', parentField: 'parentId' }],
 *   adapter: createMongooseAdapter({
 *     model: CategoryModel,
 *     repository: categoryRepository, // Must implement getTree/getChildren
 *   }),
 * });
 * ```
 */
export interface ITreeController<TDoc = unknown> {
  /**
   * Get the full hierarchical tree
   * Called by: GET /tree
   */
  getTree(req: IRequestContext): Promise<IControllerResponse<TDoc[]>>;

  /**
   * Get direct children of a parent node
   * Called by: GET /:parent/children
   */
  getChildren(req: IRequestContext): Promise<IControllerResponse<TDoc[]>>;
}

/**
 * Owned By User Preset
 *
 * This preset does NOT require controller methods - it adds middleware only.
 * Middleware automatically enforces ownership checks on update/delete operations.
 *
 * **Behavior:**
 * - Users can only update/delete resources where `ownerField` matches their user ID
 * - Admins (configurable via `bypassRoles`) can modify any resource
 *
 * **No controller interface needed** - ownership is enforced via middleware.
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'post',
 *   presets: [{ name: 'ownedByUser', ownerField: 'authorId' }],
 * });
 * ```
 */
export type IOwnedByUserPreset = never;

/**
 * Multi-Tenant Preset
 *
 * This preset does NOT require controller methods - it adds middleware only.
 * Middleware automatically filters resources by organization/tenant ID.
 *
 * **Behavior:**
 * - All list/get operations are automatically filtered by `tenantField`
 * - Create operations automatically inject the tenant ID
 * - Superadmins (configurable via `bypassRoles`) can access all tenants
 *
 * **No controller interface needed** - tenant isolation is enforced via middleware.
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'invoice',
 *   presets: [{ name: 'multiTenant', tenantField: 'organizationId' }],
 * });
 * ```
 */
export type IMultiTenantPreset = never;

/**
 * Audited Preset
 *
 * This preset does NOT require controller methods - it adds middleware only.
 * Middleware automatically populates `createdBy`/`updatedBy` fields from authenticated user.
 *
 * **Behavior:**
 * - On create: Sets both `createdBy` and `updatedBy` to current user ID
 * - On update: Sets `updatedBy` to current user ID
 * - Fields are marked as `systemManaged` in schemas (excluded from user input)
 *
 * **No controller interface needed** - audit fields are managed via middleware.
 *
 * @example
 * ```typescript
 * defineResource({
 *   name: 'product',
 *   presets: ['audited'], // Uses default fields: createdBy, updatedBy
 * });
 * ```
 */
export type IAuditedPreset = never;

/**
 * Combined type for controllers using multiple presets
 *
 * @example
 * ```typescript
 * import type { IPresetController } from '@classytic/arc/presets';
 *
 * class ProductController
 *   extends BaseController<Product>
 *   implements IPresetController<Product, 'softDelete' | 'slugLookup' | 'tree'>
 * {
 *   // TypeScript ensures all required methods are implemented
 * }
 * ```
 */
export type IPresetController<
  TDoc = unknown,
  TPresets extends 'softDelete' | 'slugLookup' | 'tree' | never = never,
> = TPresets extends 'softDelete'
  ? ISoftDeleteController<TDoc>
  : TPresets extends 'slugLookup'
    ? ISlugLookupController<TDoc>
    : TPresets extends 'tree'
      ? ITreeController<TDoc>
      : unknown;
