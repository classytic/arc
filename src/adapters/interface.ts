/**
 * Data Adapter Interface - Database Abstraction Layer
 *
 * Core abstraction that allows Arc to work with any database.
 * This is the ONLY contract between Arc and data persistence.
 */

import type { CrudRepository, OpenApiSchemas, RouteSchemaOptions } from '../types/index.js';

/**
 * Minimal repository interface for flexible adapter compatibility.
 * Any repository with these method signatures is accepted — no `as any` needed.
 *
 * CrudRepository<TDoc> and MongoKit Repository both satisfy this interface.
 */
export interface RepositoryLike {
  getAll(params?: unknown): Promise<unknown>;
  getById(id: string, options?: unknown): Promise<unknown>;
  create(data: unknown, options?: unknown): Promise<unknown>;
  update(id: string, data: unknown, options?: unknown): Promise<unknown>;
  delete(id: string, options?: unknown): Promise<unknown>;
  [key: string]: unknown;
}

export interface DataAdapter<TDoc = unknown> {
  /**
   * Repository implementing CRUD operations
   * Accepts CrudRepository, MongoKit Repository, or any compatible object
   */
  repository: CrudRepository<TDoc> | RepositoryLike;

  /** Adapter identifier for introspection */
  readonly type: 'mongoose' | 'prisma' | 'drizzle' | 'typeorm' | 'custom';

  /** Human-readable name */
  readonly name: string;

  /**
   * Generate OpenAPI schemas for CRUD operations
   *
   * This method allows each adapter to generate schemas specific to its ORM/database.
   * For example, Mongoose adapter can use mongokit to generate schemas from Mongoose models.
   *
   * @param options - Schema generation options (field rules, populate settings, etc.)
   * @returns OpenAPI schemas for CRUD operations or null if not supported
   */
  generateSchemas?(options?: RouteSchemaOptions): OpenApiSchemas | null;

  /** Extract schema metadata for OpenAPI/introspection */
  getSchemaMetadata?(): SchemaMetadata | null;

  /** Validate data against schema before persistence */
  validate?(data: unknown): Promise<ValidationResult> | ValidationResult;

  /** Health check for database connection */
  healthCheck?(): Promise<boolean>;

  /**
   * Custom filter matching for policy enforcement.
   * Falls back to built-in MongoDB-style matching if not provided.
   * Override this for SQL adapters or non-MongoDB query operators.
   */
  matchesFilter?: (item: unknown, filters: Record<string, unknown>) => boolean;

  /** Close/cleanup resources */
  close?(): Promise<void>;
}

export interface SchemaMetadata {
  name: string;
  fields: Record<string, FieldMetadata>;
  indexes?: Array<{ fields: string[]; unique?: boolean; sparse?: boolean }>;
  relations?: Record<string, RelationMetadata>;
}

export interface FieldMetadata {
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'objectId' | 'enum';
  required?: boolean;
  unique?: boolean;
  default?: unknown;
  enum?: Array<string | number>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  ref?: string;
  array?: boolean;
}

export interface RelationMetadata {
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  target: string;
  foreignKey?: string;
  through?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ field: string; message: string; code?: string }>;
}

export type AdapterFactory<TDoc> = (config: unknown) => DataAdapter<TDoc>;
