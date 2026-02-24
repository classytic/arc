/**
 * Repository Interface - Database-Agnostic CRUD Operations
 *
 * This is the standard interface that all repositories must implement.
 * MongoKit Repository already implements this interface.
 *
 * @example
 * ```typescript
 * import type { CrudRepository } from '@classytic/arc';
 *
 * // Your repository automatically satisfies this interface
 * const userRepo: CrudRepository<UserDocument> = new Repository(UserModel);
 * ```
 */

/**
 * Query options for read operations
 */
export interface QueryOptions {
  /** Transaction session — adapters handle the actual type (e.g., Mongoose ClientSession) */
  session?: unknown;
  /** Field selection - include or exclude fields */
  select?: string | string[] | Record<string, 0 | 1>;
  /** Relations to populate - string, array, or Mongoose populate options */
  populate?: string | string[] | Record<string, unknown>;
  /** Return plain JS objects instead of Mongoose documents */
  lean?: boolean;
  /** Allow additional adapter-specific options */
  [key: string]: unknown;
}

/**
 * Pagination parameters for list operations
 */
export interface PaginationParams<TDoc = unknown> {
  /** Filter criteria */
  filters?: Partial<TDoc> & Record<string, unknown>;
  /** Sort specification - string ("-createdAt") or object ({ createdAt: -1 }) */
  sort?: string | Record<string, 1 | -1>;
  /** Page number (1-indexed) */
  page?: number;
  /** Items per page */
  limit?: number;
  /** Allow additional options (select, populate, etc.) */
  [key: string]: unknown;
}

/**
 * Paginated result from list operations
 */
export interface PaginatedResult<TDoc> {
  /** Documents for current page */
  docs: TDoc[];
  /** Current page number */
  page: number;
  /** Items per page */
  limit: number;
  /** Total document count */
  total: number;
  /** Total page count */
  pages: number;
  /** Has next page */
  hasNext: boolean;
  /** Has previous page */
  hasPrev: boolean;
}

/**
 * Standard CRUD Repository Interface
 *
 * Defines the contract for data access operations.
 * All database adapters (MongoKit, Prisma, etc.) implement this interface.
 *
 * @typeParam TDoc - The document/entity type
 */
export interface CrudRepository<TDoc> {
  /**
   * Get paginated list of documents
   */
  getAll(
    params?: PaginationParams<TDoc>,
    options?: QueryOptions
  ): Promise<PaginatedResult<TDoc>>;

  /**
   * Get single document by ID
   */
  getById(
    id: string,
    options?: QueryOptions
  ): Promise<TDoc | null>;

  /**
   * Create new document
   */
  create(
    data: Partial<TDoc>,
    options?: { session?: unknown; [key: string]: unknown }
  ): Promise<TDoc>;

  /**
   * Update document by ID
   */
  update(
    id: string,
    data: Partial<TDoc>,
    options?: QueryOptions
  ): Promise<TDoc | null>;

  /**
   * Delete document by ID
   */
  delete(
    id: string,
    options?: { session?: unknown; [key: string]: unknown }
  ): Promise<{ success: boolean; message: string }>;

  /** Allow custom methods (getBySlug, getTree, restore, etc.) */
  [key: string]: unknown;
}

/**
 * Extract document type from a repository
 *
 * @example
 * ```typescript
 * type UserDoc = InferDoc<typeof userRepository>;
 * // UserDoc is now the document type of userRepository
 * ```
 */
export type InferDoc<R> = R extends CrudRepository<infer T> ? T : never;
