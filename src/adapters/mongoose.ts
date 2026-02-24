/**
 * Mongoose Adapter - Type-Safe Database Adapter
 *
 * Bridges Mongoose models with Arc's resource system.
 * Proper generics eliminate the need for 'as any' casts.
 */

import type { Model } from 'mongoose';
import type { DataAdapter, SchemaMetadata, RepositoryLike } from './interface.js';
import type { CrudRepository, RouteSchemaOptions, OpenApiSchemas, AnyRecord } from '../types/index.js';
import { isMongooseModel, isRepository } from './types.js';

/**
 * Mongoose SchemaType internal shape (not fully exposed by @types/mongoose)
 * Used to extract field metadata from schema paths
 */
interface MongooseSchemaType {
  instance: string;
  isRequired?: boolean;
  options?: {
    ref?: string;
    enum?: Array<string | number>;
    minlength?: number;
    maxlength?: number;
    min?: number;
    max?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ============================================================================
// Mongoose Adapter Options
// ============================================================================

/**
 * Options for creating a Mongoose adapter
 *
 * @typeParam TDoc - The document type (inferred or explicit)
 */
/**
 * Options for creating a Mongoose adapter
 *
 * @typeParam TDoc - The document type (inferred or explicit)
 */
export interface MongooseAdapterOptions<TDoc = unknown> {
  /** Mongoose model instance — accepts any Mongoose model without Document constraint */
  model: Model<any>;
  /** Repository implementing CRUD operations - accepts any repository-like object */
  repository: CrudRepository<TDoc> | RepositoryLike;
}

// ============================================================================
// Mongoose Adapter
// ============================================================================

/**
 * Mongoose data adapter with proper type safety
 *
 * @typeParam TDoc - The document type
 */
export class MongooseAdapter<TDoc = unknown> implements DataAdapter<TDoc> {
  readonly type = 'mongoose' as const;
  readonly name: string;
  readonly model: Model<any>;
  readonly repository: CrudRepository<TDoc> | RepositoryLike;

  constructor(options: MongooseAdapterOptions<TDoc>) {
    // Runtime validation
    if (!isMongooseModel(options.model)) {
      throw new TypeError(
        'MongooseAdapter: Invalid model. Expected Mongoose Model instance.\n' +
        'Usage: createMongooseAdapter({ model: YourModel, repository: yourRepo })'
      );
    }

    if (!isRepository(options.repository)) {
      throw new TypeError(
        'MongooseAdapter: Invalid repository. Expected CrudRepository instance.\n' +
        'Usage: createMongooseAdapter({ model: YourModel, repository: yourRepo })'
      );
    }

    this.model = options.model;
    this.repository = options.repository;
    this.name = `MongooseAdapter<${options.model.modelName}>`;
  }

  /**
   * Get schema metadata from Mongoose model
   */
  getSchemaMetadata(): SchemaMetadata {
    const schema = this.model.schema;
    const paths = schema.paths;
    const fields: SchemaMetadata['fields'] = {};

    for (const [fieldName, schemaType] of Object.entries(paths)) {
      // Skip internal fields
      if (fieldName.startsWith('_') && fieldName !== '_id') continue;

      const typeInfo = schemaType as MongooseSchemaType;
      const mongooseType = typeInfo.instance || 'Mixed';

      // Map Mongoose types to our FieldMetadata types
      const typeMap: Record<string, 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'objectId' | 'enum'> = {
        String: 'string',
        Number: 'number',
        Boolean: 'boolean',
        Date: 'date',
        ObjectID: 'objectId',
        Array: 'array',
        Mixed: 'object',
        Buffer: 'object',
        Embedded: 'object',
      };

      fields[fieldName] = {
        type: typeMap[mongooseType] ?? 'object',
        required: !!typeInfo.isRequired,
        ref: typeInfo.options?.ref,
      };
    }

    return {
      name: this.model.modelName,
      fields,
      relations: this.extractRelations(paths),
    };
  }

  /**
   * Generate OpenAPI schemas from Mongoose model
   */
  generateSchemas(schemaOptions?: RouteSchemaOptions): OpenApiSchemas | null {
    try {
      const schema = this.model.schema;
      const paths = schema.paths;
      const properties: AnyRecord = {};
      const required: string[] = [];

      // Extract field rules from schema options
      const fieldRules = schemaOptions?.fieldRules || {};
      const blockedFields = new Set<string>(
        Object.entries(fieldRules)
          .filter(([, rules]) => rules.systemManaged || rules.hidden)
          .map(([field]) => field)
      );

      for (const [fieldName, schemaType] of Object.entries(paths)) {
        // Skip internal and blocked fields
        if (fieldName.startsWith('__')) continue;
        if (blockedFields.has(fieldName)) continue;

        const typeInfo = schemaType as MongooseSchemaType;
        properties[fieldName] = this.mongooseTypeToOpenApi(typeInfo);

        if (typeInfo.isRequired) {
          required.push(fieldName);
        }
      }

      const baseSchema = {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      };

      return {
        create: {
          body: {
            ...baseSchema,
            // Remove system-managed fields from create
            properties: Object.fromEntries(
              Object.entries(properties).filter(
                ([field]) =>
                  !['_id', 'createdAt', 'updatedAt', 'deletedAt'].includes(field)
              )
            ),
          },
        },
        update: {
          body: {
            ...baseSchema,
            // All fields optional for PATCH
            required: undefined,
            properties: Object.fromEntries(
              Object.entries(properties).filter(
                ([field]) =>
                  !['_id', 'createdAt', 'updatedAt', 'deletedAt'].includes(field)
              )
            ),
          },
        },
        response: {
          type: 'object',
          properties,
        },
      };
    } catch {
      // Schema generation is optional - fail silently
      return null;
    }
  }

  /**
   * Extract relation metadata
   */
  private extractRelations(paths: Record<string, unknown>): SchemaMetadata['relations'] {
    const relations: Record<string, { type: 'one-to-one' | 'one-to-many' | 'many-to-many'; target: string; foreignKey?: string }> = {};

    for (const [fieldName, schemaType] of Object.entries(paths)) {
      const ref = (schemaType as MongooseSchemaType).options?.ref;
      if (ref) {
        relations[fieldName] = {
          type: 'one-to-one', // Mongoose refs are typically one-to-one
          target: ref,
          foreignKey: fieldName,
        };
      }
    }

    return Object.keys(relations).length > 0 ? relations : undefined;
  }

  /**
   * Convert Mongoose type to OpenAPI type
   */
  private mongooseTypeToOpenApi(typeInfo: MongooseSchemaType): AnyRecord {
    const instance = typeInfo.instance;
    const options = typeInfo.options || {};

    const baseType: AnyRecord = {};

    switch (instance) {
      case 'String':
        baseType.type = 'string';
        if (options.enum) baseType.enum = options.enum;
        if (options.minlength) baseType.minLength = options.minlength;
        if (options.maxlength) baseType.maxLength = options.maxlength;
        break;
      case 'Number':
        baseType.type = 'number';
        if (options.min !== undefined) baseType.minimum = options.min;
        if (options.max !== undefined) baseType.maximum = options.max;
        break;
      case 'Boolean':
        baseType.type = 'boolean';
        break;
      case 'Date':
        baseType.type = 'string';
        baseType.format = 'date-time';
        break;
      case 'ObjectID':
        baseType.type = 'string';
        baseType.pattern = '^[a-f\\d]{24}$';
        break;
      case 'Array':
        baseType.type = 'array';
        baseType.items = { type: 'string' }; // Default, can be improved
        break;
      default:
        baseType.type = 'object';
    }

    return baseType;
  }
}

// ============================================================================
// Factory Function with Type Inference
// ============================================================================

/**
 * Create Mongoose adapter with flexible type acceptance.
 * Accepts any repository with CRUD methods — no `as any` needed.
 *
 * @example
 * ```typescript
 * // Object form (explicit)
 * const adapter = createMongooseAdapter({
 *   model: ProductModel,
 *   repository: productRepository,
 * });
 *
 * // Shorthand form (2-arg) — most common path
 * const adapter = createMongooseAdapter(ProductModel, productRepository);
 * ```
 */
export function createMongooseAdapter<TDoc = unknown>(
  model: Model<any>,
  repository: CrudRepository<TDoc> | RepositoryLike,
): DataAdapter<TDoc>;
export function createMongooseAdapter<TDoc = unknown>(
  options: MongooseAdapterOptions<TDoc>,
): DataAdapter<TDoc>;
export function createMongooseAdapter<TDoc = unknown>(
  modelOrOptions: Model<any> | MongooseAdapterOptions<TDoc>,
  repository?: CrudRepository<TDoc> | RepositoryLike,
): DataAdapter<TDoc> {
  if (isMongooseModel(modelOrOptions)) {
    if (!repository) {
      throw new TypeError(
        'createMongooseAdapter: repository is required when using 2-arg form.\n' +
        'Usage: createMongooseAdapter(Model, repository)'
      );
    }
    return new MongooseAdapter<TDoc>({ model: modelOrOptions, repository });
  }
  return new MongooseAdapter<TDoc>(modelOrOptions as MongooseAdapterOptions<TDoc>);
}

// ============================================================================
// Exports
// ============================================================================

export default createMongooseAdapter;
