/**
 * Prisma Adapter - PostgreSQL/MySQL/SQLite Implementation
 *
 * @experimental This adapter is implemented but has no integration tests yet.
 * Use in production at your own risk. The Mongoose adapter is the recommended
 * and battle-tested path.
 *
 * Bridges Prisma Client with Arc's DataAdapter interface.
 * Supports Prisma 5+ with all database providers.
 *
 * Implemented features:
 * - Schema generation (OpenAPI docs from DMMF)
 * - Health checks (database connectivity)
 * - Query parsing (URL params → Prisma where/orderBy)
 * - Policy filter translation
 * - Soft delete preset support
 *
 * Known gaps:
 * - No integration test coverage
 * - Multi-tenant isolation relies on caller-provided policyFilters (no auto-enforcement)
 *
 * @example
 * ```typescript
 * import { PrismaClient, Prisma } from '@prisma/client';
 * import { createPrismaAdapter, PrismaQueryParser } from '@classytic/arc/adapters';
 *
 * const prisma = new PrismaClient();
 *
 * const userAdapter = createPrismaAdapter({
 *   client: prisma,
 *   modelName: 'user',
 *   repository: new UserRepository(prisma),
 *   dmmf: Prisma.dmmf, // For schema generation
 *   queryParser: new PrismaQueryParser(), // Optional: custom parser
 * });
 * ```
 */

import { DEFAULT_LIMIT, DEFAULT_MAX_LIMIT, RESERVED_QUERY_PARAMS } from "../constants.js";
import type {
  AnyRecord,
  CrudRepository,
  OpenApiSchemas,
  ParsedQuery,
  QueryParserInterface,
  RouteSchemaOptions,
} from "../types/index.js";
import type { DataAdapter, FieldMetadata, SchemaMetadata, ValidationResult } from "./interface.js";

// ============================================================================
// Prisma DMMF Types (runtime shapes from @prisma/client)
// ============================================================================

/** Prisma DMMF field shape */
interface DmmfField {
  name: string;
  type: string;
  kind: string;
  isList: boolean;
  isRequired: boolean;
  isUnique?: boolean;
  isId?: boolean;
  isGenerated?: boolean;
  hasDefaultValue?: boolean;
  default?: unknown;
  documentation?: string;
  relationName?: string;
}

/** Prisma DMMF enum value */
interface DmmfEnumValue {
  name: string;
}

/** Prisma DMMF enum */
interface DmmfEnum {
  name: string;
  values: DmmfEnumValue[];
}

/** Prisma DMMF model shape */
interface DmmfModel {
  name: string;
  fields: DmmfField[];
  uniqueIndexes?: Array<{ fields: string[] }>;
}

/** Prisma DMMF datamodel */
interface DmmfDatamodel {
  models: DmmfModel[];
  enums?: DmmfEnum[];
}

/** Prisma DMMF root shape */
interface PrismaDmmf {
  datamodel?: DmmfDatamodel;
}

/** Prisma client delegate (model accessor) */
interface PrismaDelegate {
  findMany(args?: unknown): Promise<unknown[]>;
}

/** Prisma client shape */
interface PrismaClientLike {
  $disconnect(): Promise<void>;
  [key: string]: unknown;
}

// ============================================================================
// Prisma Query Parser
// ============================================================================

/**
 * Options for PrismaQueryParser
 */
export interface PrismaQueryParserOptions {
  /** Maximum allowed limit value (default: 1000) */
  maxLimit?: number;
  /** Default limit for pagination (default: 20) */
  defaultLimit?: number;
  /** Enable soft delete filtering by default (default: true) */
  softDeleteEnabled?: boolean;
  /** Field name for soft delete (default: 'deletedAt') */
  softDeleteField?: string;
}

/**
 * Prisma Query Parser - Converts URL parameters to Prisma query format
 *
 * Translates Arc's query format to Prisma's where/orderBy/take/skip structure.
 *
 * @example
 * ```typescript
 * const parser = new PrismaQueryParser();
 *
 * // URL: ?status=active&price[gte]=100&sort=-createdAt&page=2&limit=10
 * const prismaQuery = parser.toPrismaQuery(parsedQuery);
 * // Returns:
 * // {
 * //   where: { status: 'active', price: { gte: 100 }, deletedAt: null },
 * //   orderBy: { createdAt: 'desc' },
 * //   take: 10,
 * //   skip: 10,
 * // }
 * ```
 */
export class PrismaQueryParser implements QueryParserInterface {
  private readonly maxLimit: number;
  private readonly defaultLimit: number;
  private readonly softDeleteEnabled: boolean;
  private readonly softDeleteField: string;

  /** Map Arc operators to Prisma operators */
  private readonly operatorMap: Record<string, string> = {
    $eq: "equals",
    $ne: "not",
    $gt: "gt",
    $gte: "gte",
    $lt: "lt",
    $lte: "lte",
    $in: "in",
    $nin: "notIn",
    $regex: "contains",
    $exists: undefined as unknown as string, // Handled specially in translateFilters
  };

  constructor(options: PrismaQueryParserOptions = {}) {
    this.maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.softDeleteEnabled = options.softDeleteEnabled ?? true;
    this.softDeleteField = options.softDeleteField ?? "deletedAt";
  }

  /**
   * Parse URL query parameters (delegates to ArcQueryParser format)
   */
  parse(query: Record<string, unknown> | null | undefined): ParsedQuery {
    const q = query ?? {};

    const page = this.parseNumber(q.page, 1);
    const limit = Math.min(this.parseNumber(q.limit, this.defaultLimit), this.maxLimit);

    return {
      filters: this.parseFilters(q),
      limit,
      page,
      sort: this.parseSort(q.sort),
      search: q.search as string | undefined,
      select: this.parseSelect(q.select),
    };
  }

  /**
   * Convert ParsedQuery to Prisma query options
   */
  toPrismaQuery(parsed: ParsedQuery, policyFilters?: Record<string, unknown>): PrismaQueryOptions {
    const where: Record<string, unknown> = {};

    // Apply filters
    if (parsed.filters) {
      Object.assign(where, this.translateFilters(parsed.filters));
    }

    // Apply policy filters (multi-tenant, ownership, etc.)
    if (policyFilters) {
      Object.assign(where, this.translateFilters(policyFilters));
    }

    // Apply soft delete filter
    if (this.softDeleteEnabled) {
      where[this.softDeleteField] = null;
    }

    // Build orderBy
    const orderBy: Array<Record<string, "asc" | "desc">> | undefined = parsed.sort
      ? Object.entries(parsed.sort).map(([field, dir]) => ({
          [field]: (dir === 1 ? "asc" : "desc") as "asc" | "desc",
        }))
      : undefined;

    // Build pagination
    const take = parsed.limit ?? this.defaultLimit;
    const skip = parsed.page ? (parsed.page - 1) * take : 0;

    // Build select
    const select = parsed.select
      ? Object.fromEntries(
          Object.entries(parsed.select)
            .filter(([, v]) => v === 1)
            .map(([k]) => [k, true]),
        )
      : undefined;

    return {
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: orderBy && orderBy.length > 0 ? orderBy : undefined,
      take,
      skip,
      select: select && Object.keys(select).length > 0 ? select : undefined,
    };
  }

  /**
   * Translate Arc/MongoDB-style filters to Prisma where clause
   */
  private translateFilters(filters: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(filters)) {
      if (value === null || value === undefined) continue;

      // Handle nested operator objects: { status: { $ne: 'deleted' } }
      if (typeof value === "object" && !Array.isArray(value)) {
        const prismaCondition: Record<string, unknown> = {};

        for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
          if (op === "$exists") {
            // $exists: true → { not: null }, $exists: false → null
            result[field] = opValue ? { not: null } : null;
            continue;
          }

          const prismaOp = this.operatorMap[op];
          if (prismaOp) {
            prismaCondition[prismaOp] = opValue;
          }
        }

        if (Object.keys(prismaCondition).length > 0) {
          result[field] = prismaCondition;
        }
      } else {
        // Direct equality
        result[field] = value;
      }
    }

    return result;
  }

  private parseNumber(value: unknown, defaultValue: number): number {
    if (value === undefined || value === null) return defaultValue;
    const num = parseInt(String(value), 10);
    return Number.isNaN(num) ? defaultValue : Math.max(1, num);
  }

  private parseSort(value: unknown): Record<string, 1 | -1> | undefined {
    if (!value) return undefined;

    const sortStr = String(value);
    const result: Record<string, 1 | -1> = {};

    for (const field of sortStr.split(",")) {
      const trimmed = field.trim();
      if (!trimmed || !/^-?[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) continue;

      if (trimmed.startsWith("-")) {
        result[trimmed.slice(1)] = -1;
      } else {
        result[trimmed] = 1;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  private parseSelect(value: unknown): Record<string, 0 | 1> | undefined {
    if (!value) return undefined;

    const result: Record<string, 0 | 1> = {};

    for (const field of String(value).split(",")) {
      const trimmed = field.trim();
      if (!trimmed || !/^-?[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) continue;

      result[trimmed.startsWith("-") ? trimmed.slice(1) : trimmed] = trimmed.startsWith("-")
        ? 0
        : 1;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  private parseFilters(query: Record<string, unknown>): Record<string, unknown> {
    const filters: Record<string, unknown> = {};

    const operators: Record<string, string> = {
      eq: "$eq",
      ne: "$ne",
      gt: "$gt",
      gte: "$gte",
      lt: "$lt",
      lte: "$lte",
      in: "$in",
      nin: "$nin",
      like: "$regex",
      contains: "$regex",
      exists: "$exists",
    };

    for (const [key, value] of Object.entries(query)) {
      if (RESERVED_QUERY_PARAMS.has(key) || value === undefined || value === null) continue;

      const match = key.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)(?:\[([a-z]+)\])?$/);
      if (!match) continue;

      const [, fieldName, operator] = match;
      if (!fieldName) continue;

      if (operator && operators[operator]) {
        if (!filters[fieldName]) filters[fieldName] = {};
        (filters[fieldName] as Record<string, unknown>)[operators[operator]] = this.coerceValue(
          value,
          operator,
        );
      } else if (!operator) {
        filters[fieldName] = this.coerceValue(value);
      }
    }

    return filters;
  }

  private coerceValue(value: unknown, operator?: string): unknown {
    if (operator === "in" || operator === "nin") {
      if (Array.isArray(value)) return value.map((v) => this.coerceValue(v));
      if (typeof value === "string" && value.includes(",")) {
        return value.split(",").map((v) => this.coerceValue(v.trim()));
      }
      return [this.coerceValue(value)];
    }

    if (operator === "exists") {
      return String(value).toLowerCase() === "true" || value === "1";
    }

    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;

    if (typeof value === "string") {
      const num = Number(value);
      if (!Number.isNaN(num) && value.trim() !== "") return num;
    }

    return value;
  }
}

/**
 * Prisma query options returned by toPrismaQuery
 */
export interface PrismaQueryOptions {
  where?: Record<string, unknown>;
  orderBy?: Array<Record<string, "asc" | "desc">>;
  take?: number;
  skip?: number;
  select?: Record<string, boolean>;
  include?: Record<string, boolean>;
}

// ============================================================================
// Prisma Adapter Options
// ============================================================================

export interface PrismaAdapterOptions<TModel> {
  /** Prisma client instance */
  client: PrismaClientLike;
  /** Model name (e.g., 'user', 'product') */
  modelName: string;
  /** Repository instance implementing CRUD operations */
  repository: CrudRepository<TModel>;
  /** Optional: Prisma DMMF (Data Model Meta Format) for schema extraction */
  dmmf?: PrismaDmmf;
  /** Optional: Custom query parser (default: PrismaQueryParser) */
  queryParser?: PrismaQueryParser;
  /** Enable soft delete filtering (default: true) */
  softDeleteEnabled?: boolean;
  /** Field name for soft delete (default: 'deletedAt') */
  softDeleteField?: string;
}

export class PrismaAdapter<TModel = unknown> implements DataAdapter<TModel> {
  readonly type = "prisma" as const;
  readonly name: string;
  readonly repository: CrudRepository<TModel>;
  readonly queryParser: PrismaQueryParser;

  private client: PrismaClientLike;
  private modelName: string;
  private dmmf?: PrismaDmmf;
  private softDeleteEnabled: boolean;
  private softDeleteField: string;

  constructor(options: PrismaAdapterOptions<TModel>) {
    this.client = options.client;
    this.modelName = options.modelName;
    this.repository = options.repository;
    this.dmmf = options.dmmf;
    this.name = `prisma:${options.modelName}`;
    this.softDeleteEnabled = options.softDeleteEnabled ?? true;
    this.softDeleteField = options.softDeleteField ?? "deletedAt";

    // Initialize query parser
    this.queryParser =
      options.queryParser ??
      new PrismaQueryParser({
        softDeleteEnabled: this.softDeleteEnabled,
        softDeleteField: this.softDeleteField,
      });
  }

  /**
   * Parse URL query parameters and convert to Prisma query options
   */
  parseQuery(
    query: Record<string, unknown>,
    policyFilters?: Record<string, unknown>,
  ): PrismaQueryOptions {
    const parsed = this.queryParser.parse(query);
    return this.queryParser.toPrismaQuery(parsed, policyFilters);
  }

  /**
   * Apply policy filters to existing Prisma where clause
   * Used for multi-tenant, ownership, and other security filters
   */
  applyPolicyFilters(
    where: Record<string, unknown>,
    policyFilters: Record<string, unknown>,
  ): Record<string, unknown> {
    return { ...where, ...policyFilters };
  }

  generateSchemas(options?: RouteSchemaOptions): OpenApiSchemas | null {
    // Extract schema from Prisma DMMF if available
    if (!this.dmmf) return null;

    try {
      const model = this.dmmf.datamodel?.models?.find(
        (m: DmmfModel) => m.name.toLowerCase() === this.modelName.toLowerCase(),
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
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        listQuery: {
          type: "object",
          properties: {
            page: { type: "number", minimum: 1, description: "Page number for pagination" },
            limit: { type: "number", minimum: 1, maximum: 100, description: "Items per page" },
            sort: { type: "string", description: 'Sort field (e.g., "name", "-createdAt")' },
            // Note: Actual filtering requires custom query parser implementation
            // This is placeholder documentation only
          },
        },
      };
    } catch {
      // Schema generation is optional - fail silently
      return null;
    }
  }

  getSchemaMetadata(): SchemaMetadata | null {
    if (!this.dmmf) return null;

    try {
      const model = this.dmmf.datamodel?.models?.find(
        (m: DmmfModel) => m.name.toLowerCase() === this.modelName.toLowerCase(),
      );

      if (!model) return null;

      const fields: Record<string, FieldMetadata> = {};

      for (const field of model.fields) {
        fields[field.name] = this.convertPrismaFieldToMetadata(field);
      }

      return {
        name: model.name,
        fields,
        indexes: model.uniqueIndexes?.map((idx: { fields: string[] }) => ({
          fields: idx.fields,
          unique: true,
        })),
      };
    } catch (_err) {
      return null;
    }
  }

  async validate(data: unknown): Promise<ValidationResult> {
    // Prisma validates on write, so we do basic type checking here
    if (!data || typeof data !== "object") {
      return {
        valid: false,
        errors: [{ field: "root", message: "Data must be an object" }],
      };
    }

    // Get required fields from DMMF
    if (this.dmmf) {
      try {
        const model = this.dmmf.datamodel?.models?.find(
          (m: DmmfModel) => m.name.toLowerCase() === this.modelName.toLowerCase(),
        );

        if (model) {
          const requiredFields = model.fields.filter(
            (f: DmmfField) => f.isRequired && !f.hasDefaultValue && !f.isGenerated,
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
      } catch (_err) {
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
      const delegate = this.client[delegateName] as PrismaDelegate | undefined;
      if (!delegate) {
        return false;
      }
      await delegate.findMany({ take: 1 });
      return true;
    } catch (_err) {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.$disconnect();
    } catch (_err) {
      // Already disconnected or error - ignore
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private buildEntitySchema(model: DmmfModel, options?: RouteSchemaOptions): AnyRecord {
    const properties: Record<string, AnyRecord> = {};
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
      type: "object",
      properties,
      ...(required.length > 0 && { required }),
    };
  }

  private buildCreateSchema(model: DmmfModel, options?: RouteSchemaOptions): AnyRecord {
    const properties: Record<string, AnyRecord> = {};
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
      type: "object",
      properties,
      ...(required.length > 0 && { required }),
    };
  }

  private buildUpdateSchema(model: DmmfModel, options?: RouteSchemaOptions): AnyRecord {
    const properties: Record<string, AnyRecord> = {};

    for (const field of model.fields) {
      // Skip auto-generated, ID, and relation fields for update
      if (field.isGenerated || field.isId || field.relationName) continue;
      if (this.shouldSkipField(field, options)) continue;

      properties[field.name] = this.convertPrismaFieldToJsonSchema(field);
    }

    return {
      type: "object",
      properties,
    };
  }

  private shouldSkipField(field: DmmfField, options?: RouteSchemaOptions): boolean {
    // Check if field is in excludeFields
    if (options?.excludeFields?.includes(field.name)) {
      return true;
    }

    // Skip internal Prisma fields
    if (field.name.startsWith("_")) {
      return true;
    }

    return false;
  }

  private convertPrismaFieldToJsonSchema(field: DmmfField): AnyRecord {
    const schema: AnyRecord = {};

    // Map Prisma types to JSON Schema types
    switch (field.type) {
      case "String":
        schema.type = "string";
        break;
      case "Int":
      case "BigInt":
        schema.type = "integer";
        break;
      case "Float":
      case "Decimal":
        schema.type = "number";
        break;
      case "Boolean":
        schema.type = "boolean";
        break;
      case "DateTime":
        schema.type = "string";
        schema.format = "date-time";
        break;
      case "Json":
        schema.type = "object";
        break;
      default:
        // Enums and other types
        if (field.kind === "enum") {
          schema.type = "string";
          // Extract enum values from DMMF if available
          if (this.dmmf?.datamodel?.enums) {
            const enumDef = this.dmmf.datamodel.enums.find((e: DmmfEnum) => e.name === field.type);
            if (enumDef) {
              schema.enum = enumDef.values.map((v: DmmfEnumValue) => v.name);
            }
          }
        } else {
          schema.type = "string";
        }
    }

    // Handle arrays
    if (field.isList) {
      return {
        type: "array",
        items: schema,
      };
    }

    // Add description if available
    if (field.documentation) {
      schema.description = field.documentation;
    }

    return schema;
  }

  private convertPrismaFieldToMetadata(field: DmmfField): FieldMetadata {
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

  private mapPrismaTypeToMetadataType(type: string, kind: string): FieldMetadata["type"] {
    if (kind === "enum") return "enum";

    switch (type) {
      case "String":
        return "string";
      case "Int":
      case "BigInt":
      case "Float":
      case "Decimal":
        return "number";
      case "Boolean":
        return "boolean";
      case "DateTime":
        return "date";
      case "Json":
        return "object";
      default:
        return "string";
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
  options: PrismaAdapterOptions<TModel>,
): PrismaAdapter<TModel> {
  return new PrismaAdapter(options);
}
