/**
 * Mongoose Adapter - Type-Safe Database Adapter
 *
 * Bridges Mongoose models with Arc's resource system.
 * Proper generics eliminate the need for 'as any' casts.
 */

import type { StandardRepo } from "@classytic/repo-core/repository";
import type { Model } from "mongoose";
import { SYSTEM_FIELDS } from "../constants.js";
import type { AnyRecord, OpenApiSchemas, RouteSchemaOptions } from "../types/index.js";
import { mergeFieldRuleConstraints } from "./field-rule-helpers.js";
import type {
  AdapterSchemaContext,
  DataAdapter,
  RepositoryLike,
  SchemaMetadata,
} from "./interface.js";
import { isMongooseModel, isRepository } from "./types.js";

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
 * Options for creating a Mongoose adapter.
 * TDoc is auto-inferred from the Mongoose model — no explicit type needed.
 *
 * @typeParam TDoc - Inferred from `model: Model<TDoc>`
 */
export interface MongooseAdapterOptions<TDoc = unknown> {
  /** Mongoose model instance — preserves document type for type safety */
  model: Model<TDoc>;
  /** Repository implementing CRUD operations - accepts any repository-like object */
  repository: StandardRepo<TDoc> | RepositoryLike<TDoc>;
  /**
   * External schema generator plugin for OpenAPI docs.
   * When provided, replaces the built-in basic type conversion.
   * Receives the Mongoose model and schema options, must return OpenApiSchemas.
   *
   * @example MongoKit integration
   * ```typescript
   * import { buildCrudSchemasFromModel } from '@classytic/mongokit';
   *
   * createMongooseAdapter({
   *   model: JobModel,
   *   repository: jobRepository,
   *   schemaGenerator: (model, options) => buildCrudSchemasFromModel(model, options),
   * });
   * ```
   */
  schemaGenerator?: (
    model: Model<TDoc>,
    options?: RouteSchemaOptions,
    context?: AdapterSchemaContext,
  ) => OpenApiSchemas | Record<string, unknown>;
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
  readonly type = "mongoose" as const;
  readonly name: string;
  readonly model: Model<TDoc>;
  readonly repository: StandardRepo<TDoc> | RepositoryLike<TDoc>;
  private readonly schemaGenerator?: (
    model: Model<TDoc>,
    options?: RouteSchemaOptions,
    context?: AdapterSchemaContext,
  ) => OpenApiSchemas | Record<string, unknown>;

  constructor(options: MongooseAdapterOptions<TDoc>) {
    // Runtime validation
    if (!isMongooseModel(options.model)) {
      throw new TypeError(
        "MongooseAdapter: Invalid model. Expected Mongoose Model instance.\n" +
          "Usage: createMongooseAdapter({ model: YourModel, repository: yourRepo })",
      );
    }

    if (!isRepository(options.repository)) {
      throw new TypeError(
        "MongooseAdapter: Invalid repository. Expected StandardRepo instance.\n" +
          "Usage: createMongooseAdapter({ model: YourModel, repository: yourRepo })",
      );
    }

    this.model = options.model;
    this.repository = options.repository;
    this.schemaGenerator = options.schemaGenerator;
    this.name = `MongooseAdapter<${options.model.modelName}>`;
  }

  /**
   * Get schema metadata from Mongoose model
   */
  getSchemaMetadata(): SchemaMetadata {
    const schema = this.model.schema;
    const paths = schema.paths;
    const fields: SchemaMetadata["fields"] = {};

    for (const [fieldName, schemaType] of Object.entries(paths)) {
      // Skip internal fields
      if (fieldName.startsWith("_") && fieldName !== "_id") continue;

      const typeInfo = schemaType as MongooseSchemaType;
      const mongooseType = typeInfo.instance || "Mixed";

      // Map Mongoose types to our FieldMetadata types
      const typeMap: Record<
        string,
        "string" | "number" | "boolean" | "date" | "object" | "array" | "objectId" | "enum"
      > = {
        String: "string",
        Number: "number",
        Boolean: "boolean",
        Date: "date",
        ObjectID: "objectId",
        ObjectId: "objectId",
        Array: "array",
        Mixed: "object",
        Buffer: "object",
        Embedded: "object",
      };

      fields[fieldName] = {
        type: typeMap[mongooseType] ?? "object",
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
   * Generate OpenAPI schemas from Mongoose model.
   *
   * If a `schemaGenerator` plugin was provided (e.g. MongoKit's buildCrudSchemasFromModel),
   * it is used instead of the built-in basic conversion.
   */
  generateSchemas(
    schemaOptions?: RouteSchemaOptions,
    context?: AdapterSchemaContext,
  ): OpenApiSchemas | Record<string, unknown> | null {
    try {
      // Delegate to external schema generator plugin when available.
      // Post-process with `mergeFieldRuleConstraints` so kit-produced
      // schemas honor arc's portable field-rule constraints identically to
      // the built-in fallback below.
      if (this.schemaGenerator) {
        const generated = this.schemaGenerator(this.model, schemaOptions, context);
        mergeFieldRuleConstraints(generated, schemaOptions);
        return generated;
      }

      // Built-in basic conversion (fallback)
      const schema = this.model.schema;
      const paths = schema.paths;
      const properties: AnyRecord = {};
      const required: string[] = [];

      // Extract field rules from schema options
      const fieldRules = schemaOptions?.fieldRules || {};
      const blockedFields = new Set<string>([
        // Fields marked systemManaged or hidden in fieldRules
        ...Object.entries(fieldRules)
          .filter(([, rules]) => rules.systemManaged || rules.hidden)
          .map(([field]) => field),
        // Explicit excludeFields from schemaOptions
        ...(schemaOptions?.excludeFields ?? []),
        // Hidden fields from schemaOptions
        ...(schemaOptions?.hiddenFields ?? []),
      ]);

      const readonlySet = new Set(schemaOptions?.readonlyFields ?? []);
      const optionalSet = new Set(schemaOptions?.optionalFields ?? []);

      for (const [fieldName, schemaType] of Object.entries(paths)) {
        // Skip internal and blocked fields
        if (fieldName.startsWith("__")) continue;
        if (blockedFields.has(fieldName)) continue;

        const typeInfo = schemaType as MongooseSchemaType;
        properties[fieldName] = this.mongooseTypeToOpenApi(typeInfo);

        // Merge fieldRules constraints into OpenAPI property — parity with
        // MCP's fieldRulesToZod path. Mongoose model-level constraints
        // (minlength, maxlength, min, max, enum) are already picked up by
        // mongooseTypeToOpenApi; fieldRules act as an override/supplement
        // layer for constraints that only exist in arc config.
        const rule = fieldRules[fieldName];
        if (rule) {
          const prop = properties[fieldName] as AnyRecord;
          if (rule.minLength != null && prop.minLength == null) prop.minLength = rule.minLength;
          if (rule.maxLength != null && prop.maxLength == null) prop.maxLength = rule.maxLength;
          if (rule.min != null && prop.minimum == null) prop.minimum = rule.min;
          if (rule.max != null && prop.maximum == null) prop.maximum = rule.max;
          if (rule.pattern != null && prop.pattern == null) prop.pattern = rule.pattern;
          if (rule.enum != null && prop.enum == null) prop.enum = rule.enum;
          if (rule.description != null && prop.description == null)
            prop.description = rule.description as string;
        }

        // Mark as required unless overridden
        if (
          typeInfo.isRequired &&
          !optionalSet.has(fieldName) &&
          !fieldRules[fieldName]?.optional
        ) {
          required.push(fieldName);
        }
      }

      // Build input properties — exclude system fields AND readonly fields from body schemas
      const readonlyForInput = new Set([...readonlySet]);
      for (const [field, rules] of Object.entries(fieldRules)) {
        if (rules.immutable || rules.immutableAfterCreate) readonlyForInput.add(field);
      }

      // Filter out system-managed and readonly fields for input schemas.
      const inputBlockedSet = new Set<string>([...SYSTEM_FIELDS, ...readonlyForInput]);
      const inputProperties = Object.fromEntries(
        Object.entries(properties).filter(([field]) => !inputBlockedSet.has(field)),
      );

      const inputRequired = required.filter(
        (field) => !inputBlockedSet.has(field) && !blockedFields.has(field),
      );

      // Build update properties — additionally exclude immutable fields
      const immutableSet = new Set<string>();
      for (const [field, rules] of Object.entries(fieldRules)) {
        if (rules.immutable || rules.immutableAfterCreate) immutableSet.add(field);
      }
      const updateProperties = Object.fromEntries(
        Object.entries(inputProperties).filter(([field]) => !immutableSet.has(field)),
      );

      // additionalProperties: true on bodies so the built-in fallback doesn't
      // reject unknown fields. Explicit schema generators (MongoKit) can tighten
      // this by setting `additionalProperties: false` in their own output.
      return {
        createBody: {
          type: "object",
          properties: inputProperties,
          required: inputRequired.length > 0 ? inputRequired : undefined,
          additionalProperties: true,
        },
        updateBody: {
          type: "object",
          properties: updateProperties,
          // All fields optional for PATCH — immutable fields excluded
          additionalProperties: true,
        },
        response: {
          type: "object",
          properties,
          additionalProperties: true, // Don't strip virtuals, computed fields, or DB-internal fields
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
  private extractRelations(paths: Record<string, unknown>): SchemaMetadata["relations"] {
    const relations: Record<
      string,
      {
        type: "one-to-one" | "one-to-many" | "many-to-many";
        target: string;
        foreignKey?: string;
      }
    > = {};

    for (const [fieldName, schemaType] of Object.entries(paths)) {
      const ref = (schemaType as MongooseSchemaType).options?.ref;
      if (ref) {
        relations[fieldName] = {
          type: "one-to-one", // Mongoose refs are typically one-to-one
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
      case "String":
        baseType.type = "string";
        if (options.enum) baseType.enum = options.enum;
        if (options.minlength) baseType.minLength = options.minlength;
        if (options.maxlength) baseType.maxLength = options.maxlength;
        break;
      case "Number":
        baseType.type = "number";
        if (options.min !== undefined) baseType.minimum = options.min;
        if (options.max !== undefined) baseType.maximum = options.max;
        break;
      case "Boolean":
        baseType.type = "boolean";
        break;
      case "Date":
        baseType.type = "string";
        // Don't enforce date-time format — Mongoose accepts ISO dates, timestamps,
        // and date strings. AJV format: "date-time" rejects "2026-01-15" which
        // Mongoose would happily accept. Let Mongoose handle date validation.
        break;
      case "ObjectID":
      case "ObjectId":
        baseType.type = "string";
        baseType.pattern = "^[a-f\\d]{24}$";
        break;
      case "Array": {
        baseType.type = "array";
        const ti = typeInfo as AnyRecord;

        // Subdocument array: [{ field: Type, ... }] — has nested schema
        if (ti.$isMongooseDocumentArray && ti.schema) {
          const subSchema = ti.schema as { paths: Record<string, MongooseSchemaType> };
          const subProps: AnyRecord = {};
          const subRequired: string[] = [];
          for (const [subField, subType] of Object.entries(subSchema.paths)) {
            if (subField.startsWith("_")) continue;
            subProps[subField] = this.mongooseTypeToOpenApi(subType);
            if (subType.isRequired) subRequired.push(subField);
          }
          baseType.items = {
            type: "object",
            properties: subProps,
            ...(subRequired.length > 0 ? { required: subRequired } : {}),
            additionalProperties: true,
          };
        }
        // Simple typed array: [String], [Number] — has embeddedSchemaType
        else if ((ti.embeddedSchemaType as MongooseSchemaType | undefined)?.instance) {
          baseType.items = this.mongooseTypeToOpenApi(ti.embeddedSchemaType as MongooseSchemaType);
        }
        // Mixed array — accept any type
        else {
          baseType.items = {};
        }
        break;
      }
      case "Mixed":
        // Schema.Types.Mixed — accept any value.
        // We deliberately do NOT emit a JSON Schema `type` field here. A
        // schema with no `type` matches anything, which is the right
        // representation for Mongoose's Mixed (untyped) field.
        //
        // Previously this emitted `type: ["string","number","boolean","object","array"]`
        // (a union). AJV strict mode flags union types as a `strictTypes`
        // violation (`use allowUnionTypes`), and the union ALSO excludes
        // `null`, breaking nullable Mixed fields. Omitting `type` is both
        // strict-clean and semantically more accurate.
        break;
      case "Map":
        // Map<string, V> — object with string keys
        baseType.type = "object";
        baseType.additionalProperties = true;
        break;
      case "Embedded":
      case "SubDocument":
        // Nested schema — object with flexible properties
        baseType.type = "object";
        baseType.additionalProperties = true;
        break;
      case "Buffer":
        baseType.type = "string";
        baseType.format = "binary";
        break;
      case "Decimal128":
        baseType.type = "string";
        baseType.description = "Decimal128 (high-precision number as string)";
        break;
      case "UUID":
        baseType.type = "string";
        baseType.format = "uuid";
        break;
      default:
        // Unknown type — accept any structure
        baseType.type = "object";
        baseType.additionalProperties = true;
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
  model: Model<TDoc>,
  repository: StandardRepo<TDoc> | RepositoryLike<TDoc>,
): DataAdapter<TDoc>;
export function createMongooseAdapter<TDoc = unknown>(
  options: MongooseAdapterOptions<TDoc>,
): DataAdapter<TDoc>;
export function createMongooseAdapter<TDoc = unknown>(
  modelOrOptions: Model<TDoc> | MongooseAdapterOptions<TDoc>,
  repository?: StandardRepo<TDoc> | RepositoryLike<TDoc>,
): DataAdapter<TDoc> {
  if (isMongooseModel(modelOrOptions)) {
    if (!repository) {
      throw new TypeError(
        "createMongooseAdapter: repository is required when using 2-arg form.\n" +
          "Usage: createMongooseAdapter(Model, repository)",
      );
    }
    return new MongooseAdapter<TDoc>({
      model: modelOrOptions as Model<TDoc>,
      repository,
    });
  }
  return new MongooseAdapter<TDoc>(modelOrOptions as MongooseAdapterOptions<TDoc>);
}

// ============================================================================
// Exports
// ============================================================================
