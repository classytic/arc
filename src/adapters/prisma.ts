/**
 * Prisma Adapter - PostgreSQL/MySQL/SQLite Implementation
 *
 * ⚠️ EXPERIMENTAL: Schema generation only. CRUD delegated to user-provided repository.
 *
 * Current Status:
 * ✅ Schema generation (OpenAPI docs)
 * ✅ Health checks
 * ❌ Preset integration (not tested - softDelete, multiTenant may not work)
 * ❌ Policy filter translation (not implemented)
 * ❌ Query parser (not implemented)
 *
 * You must implement your own Prisma repository that handles:
 * - Soft delete filtering (WHERE deletedAt IS NULL)
 * - Policy filters from options.filters
 * - Tenant isolation
 * - Pagination, sorting, searching
 *
 * Bridges Prisma Client with Arc's DataAdapter interface.
 * Supports Prisma 5+ with all database providers.
 */

import type { DataAdapter, SchemaMetadata, FieldMetadata, ValidationResult } from './interface.js';
import type { CrudRepository, OpenApiSchemas, RouteSchemaOptions } from '../types/index.js';

export interface PrismaAdapterOptions<TModel> {
  /** Prisma client instance */
  client: any;
  /** Model name (e.g., 'user', 'product') */
  modelName: string;
  /** Repository instance implementing CRUD operations */
  repository: CrudRepository<TModel>;
  /** Optional: Prisma DMMF (Data Model Meta Format) for schema extraction */
  dmmf?: any;
}

export class PrismaAdapter<TModel = any> implements DataAdapter<TModel> {
  readonly type = 'prisma' as const;
  readonly name: string;
  readonly repository: CrudRepository<TModel>;

  private client: any;
  private modelName: string;
  private dmmf?: any;

  constructor(options: PrismaAdapterOptions<TModel>) {
    this.client = options.client;
    this.modelName = options.modelName;
    this.repository = options.repository;
    this.dmmf = options.dmmf;
    this.name = `prisma:${options.modelName}`;

    // Warn about experimental status
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '[Arc] PrismaAdapter is EXPERIMENTAL. Schema generation only.\n' +
        'Presets (softDelete, multiTenant) may not work correctly.\n' +
        'Ensure your repository implements all Arc behaviors.\n' +
        'See: https://github.com/classytic/arc#prisma-adapter'
      );
    }
  }

  generateSchemas(options?: RouteSchemaOptions): OpenApiSchemas | null {
    // Extract schema from Prisma DMMF if available
    if (!this.dmmf) return null;

    try {
      const model = this.dmmf.datamodel?.models?.find(
        (m: any) => m.name.toLowerCase() === this.modelName.toLowerCase()
      );

      if (!model) return null;

      const entitySchema = this.buildEntitySchema(model, options);
      const createBodySchema = this.buildCreateSchema(model, options);
      const updateBodySchema = this.buildUpdateSchema(model, options);

      return {
        entity: entitySchema,
        createBody: createBodySchema,
        updateBody: updateBodySchema,
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        listQuery: {
          type: 'object',
          properties: {
            page: { type: 'number', minimum: 1, description: 'Page number for pagination' },
            limit: { type: 'number', minimum: 1, maximum: 100, description: 'Items per page' },
            sort: { type: 'string', description: 'Sort field (e.g., "name", "-createdAt")' },
            // Note: Actual filtering requires custom query parser implementation
            // This is placeholder documentation only
          },
        },
      };
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[Arc] PrismaAdapter: Failed to generate schemas:', (err as Error).message);
      }
      return null;
    }
  }

  getSchemaMetadata(): SchemaMetadata | null {
    if (!this.dmmf) return null;

    try {
      const model = this.dmmf.datamodel?.models?.find(
        (m: any) => m.name.toLowerCase() === this.modelName.toLowerCase()
      );

      if (!model) return null;

      const fields: Record<string, FieldMetadata> = {};

      for (const field of model.fields) {
        fields[field.name] = this.convertPrismaFieldToMetadata(field);
      }

      return {
        name: model.name,
        fields,
        indexes: model.uniqueIndexes?.map((idx: any) => ({
          fields: idx.fields,
          unique: true,
        })),
      };
    } catch (err) {
      return null;
    }
  }

  async validate(data: unknown): Promise<ValidationResult> {
    // Prisma validates on write, so we do basic type checking here
    if (!data || typeof data !== 'object') {
      return {
        valid: false,
        errors: [{ field: 'root', message: 'Data must be an object' }],
      };
    }

    // Get required fields from DMMF
    if (this.dmmf) {
      try {
        const model = this.dmmf.datamodel?.models?.find(
          (m: any) => m.name.toLowerCase() === this.modelName.toLowerCase()
        );

        if (model) {
          const requiredFields = model.fields.filter(
            (f: any) => f.isRequired && !f.hasDefaultValue && !f.isGenerated
          );

          const errors: Array<{ field: string; message: string }> = [];

          for (const field of requiredFields) {
            if (!(field.name in (data as Record<string, unknown>))) {
              errors.push({
                field: field.name,
                message: `${field.name} is required`,
              });
            }
          }

          if (errors.length > 0) {
            return { valid: false, errors };
          }
        }
      } catch (err) {
        // Validation failed, but we'll let Prisma handle it on write
      }
    }

    return { valid: true };
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Use findMany with take: 1 for database-agnostic health check
      // This works across all Prisma providers (SQL, MongoDB, etc.)
      // Prisma client delegates use camelCase (e.g., prisma.userProfile, not prisma.UserProfile)
      const delegateName = this.modelName.charAt(0).toLowerCase() + this.modelName.slice(1);
      const delegate = (this.client as any)[delegateName];
      if (!delegate) {
        return false;
      }
      await delegate.findMany({ take: 1 });
      return true;
    } catch (err) {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.$disconnect();
    } catch (err) {
      // Already disconnected or error - ignore
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private buildEntitySchema(model: any, options?: RouteSchemaOptions): any {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const field of model.fields) {
      // Skip internal fields unless explicitly included
      if (this.shouldSkipField(field, options)) continue;

      properties[field.name] = this.convertPrismaFieldToJsonSchema(field);

      if (field.isRequired && !field.hasDefaultValue) {
        required.push(field.name);
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
    };
  }

  private buildCreateSchema(model: any, options?: RouteSchemaOptions): any {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const field of model.fields) {
      // Skip auto-generated and relation fields for create
      if (field.isGenerated || field.relationName) continue;
      if (this.shouldSkipField(field, options)) continue;

      properties[field.name] = this.convertPrismaFieldToJsonSchema(field);

      if (field.isRequired && !field.hasDefaultValue) {
        required.push(field.name);
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
    };
  }

  private buildUpdateSchema(model: any, options?: RouteSchemaOptions): any {
    const properties: Record<string, any> = {};

    for (const field of model.fields) {
      // Skip auto-generated, ID, and relation fields for update
      if (field.isGenerated || field.isId || field.relationName) continue;
      if (this.shouldSkipField(field, options)) continue;

      properties[field.name] = this.convertPrismaFieldToJsonSchema(field);
    }

    return {
      type: 'object',
      properties,
    };
  }

  private shouldSkipField(field: any, options?: RouteSchemaOptions): boolean {
    // Check if field is in excludeFields
    if (options?.excludeFields?.includes(field.name)) {
      return true;
    }

    // Skip internal Prisma fields
    if (field.name.startsWith('_')) {
      return true;
    }

    return false;
  }

  private convertPrismaFieldToJsonSchema(field: any): any {
    const schema: any = {};

    // Map Prisma types to JSON Schema types
    switch (field.type) {
      case 'String':
        schema.type = 'string';
        break;
      case 'Int':
      case 'BigInt':
        schema.type = 'integer';
        break;
      case 'Float':
      case 'Decimal':
        schema.type = 'number';
        break;
      case 'Boolean':
        schema.type = 'boolean';
        break;
      case 'DateTime':
        schema.type = 'string';
        schema.format = 'date-time';
        break;
      case 'Json':
        schema.type = 'object';
        break;
      default:
        // Enums and other types
        if (field.kind === 'enum') {
          schema.type = 'string';
          // Extract enum values from DMMF if available
          if (this.dmmf?.datamodel?.enums) {
            const enumDef = this.dmmf.datamodel.enums.find((e: any) => e.name === field.type);
            if (enumDef) {
              schema.enum = enumDef.values.map((v: any) => v.name);
            }
          }
        } else {
          schema.type = 'string';
        }
    }

    // Handle arrays
    if (field.isList) {
      return {
        type: 'array',
        items: schema,
      };
    }

    // Add description if available
    if (field.documentation) {
      schema.description = field.documentation;
    }

    return schema;
  }

  private convertPrismaFieldToMetadata(field: any): FieldMetadata {
    const metadata: FieldMetadata = {
      type: this.mapPrismaTypeToMetadataType(field.type, field.kind),
      required: field.isRequired,
      array: field.isList,
    };

    if (field.isUnique) {
      metadata.unique = true;
    }

    if (field.hasDefaultValue) {
      metadata.default = field.default;
    }

    if (field.documentation) {
      metadata.description = field.documentation;
    }

    if (field.relationName) {
      metadata.ref = field.type;
    }

    return metadata;
  }

  private mapPrismaTypeToMetadataType(
    type: string,
    kind: string
  ): FieldMetadata['type'] {
    if (kind === 'enum') return 'enum';

    switch (type) {
      case 'String':
        return 'string';
      case 'Int':
      case 'BigInt':
      case 'Float':
      case 'Decimal':
        return 'number';
      case 'Boolean':
        return 'boolean';
      case 'DateTime':
        return 'date';
      case 'Json':
        return 'object';
      default:
        return 'string';
    }
  }
}

/**
 * Factory function to create Prisma adapter
 *
 * @example
 * import { PrismaClient } from '@prisma/client';
 * import { createPrismaAdapter } from '@classytic/arc';
 *
 * const prisma = new PrismaClient();
 *
 * const userAdapter = createPrismaAdapter({
 *   client: prisma,
 *   modelName: 'user',
 *   repository: userRepository,
 *   dmmf: Prisma.dmmf, // Optional: for schema generation
 * });
 */
export function createPrismaAdapter<TModel>(
  options: PrismaAdapterOptions<TModel>
): PrismaAdapter<TModel> {
  return new PrismaAdapter(options);
}
