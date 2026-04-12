/**
 * Response Schemas
 *
 * Standard JSON Schema definitions for API responses.
 */

import type { AnyRecord } from "../types/index.js";

// ============================================================================
// Schema Types
// ============================================================================

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema | AnyRecord>;
  required?: string[];
  items?: JsonSchema | AnyRecord;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  example?: unknown;
  [key: string]: unknown;
}

// ============================================================================
// Response Wrapper Schemas
// ============================================================================

/**
 * Base success response schema
 */
export const successResponseSchema: JsonSchema = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
  },
  required: ["success"],
};

/**
 * Error response schema
 */
export const errorResponseSchema: JsonSchema = {
  type: "object",
  properties: {
    success: { type: "boolean", example: false },
    error: { type: "string", description: "Error message" },
    code: { type: "string", description: "Error code" },
    message: { type: "string", description: "Detailed message" },
  },
  required: ["success", "error"],
};

/**
 * Pagination schema - matches MongoKit/Arc runtime format
 *
 * Runtime format (flat fields):
 * { page, limit, total, pages, hasNext, hasPrev }
 */
export const paginationSchema: JsonSchema = {
  type: "object",
  properties: {
    page: { type: "integer", example: 1 },
    limit: { type: "integer", example: 20 },
    total: { type: "integer", example: 100 },
    pages: { type: "integer", example: 5 },
    hasNext: { type: "boolean", example: true },
    hasPrev: { type: "boolean", example: false },
  },
  required: ["page", "limit", "total", "pages", "hasNext", "hasPrev"],
};

// ============================================================================
// Schema Builders
// ============================================================================

/**
 * Wrap a data schema in a success response
 */
export function wrapResponse(dataSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      success: { type: "boolean", example: true },
      data: dataSchema,
    },
    required: ["success", "data"],
    // Allow extra fields (fieldPermissions, meta spreads, etc.)
    additionalProperties: true,
  };
}

/**
 * Create a list response schema with pagination - matches MongoKit/Arc runtime format
 *
 * Runtime format:
 * { success, docs: [...], page, limit, total, pages, hasNext, hasPrev }
 *
 * Note: Uses 'docs' array (not 'data') with flat pagination fields
 */
export function listResponse(itemSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      success: { type: "boolean", example: true },
      docs: {
        type: "array",
        items: itemSchema,
      },
      // Flat pagination fields (not nested)
      page: { type: "integer", example: 1 },
      limit: { type: "integer", example: 20 },
      total: { type: "integer", example: 100 },
      pages: { type: "integer", example: 5 },
      hasNext: { type: "boolean", example: false },
      hasPrev: { type: "boolean", example: false },
    },
    required: ["success", "docs"],
    // Allow extra fields (fieldPermissions, meta spreads, etc.)
    additionalProperties: true,
  };
}

/**
 * Create a single item response schema
 *
 * Runtime format: { success, data: {...} }
 */
export function itemResponse(itemSchema: JsonSchema): JsonSchema {
  return wrapResponse(itemSchema);
}

/**
 * Create a create/update response schema
 */
export function mutationResponse(itemSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      success: { type: "boolean", example: true },
      data: itemSchema,
      message: { type: "string", example: "Created successfully" },
    },
    required: ["success", "data"],
    // Allow extra fields (fieldPermissions, meta spreads, etc.)
    additionalProperties: true,
  };
}

/**
 * Create a delete response schema
 *
 * Runtime format: { success, data: { message, id?, soft? } }
 */
export function deleteResponse(): JsonSchema {
  return {
    type: "object",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          message: { type: "string", example: "Deleted successfully" },
          id: { type: "string", example: "507f1f77bcf86cd799439011" },
          soft: { type: "boolean", example: false },
        },
        required: ["message"],
      },
    },
    required: ["success"],
    // Allow extra fields (fieldPermissions, meta spreads, etc.)
    additionalProperties: true,
  };
}

// ============================================================================
// HTTP Status Response Schemas
// ============================================================================

export const responses = {
  200: (schema: JsonSchema) => ({
    description: "Successful response",
    content: {
      "application/json": { schema },
    },
  }),

  201: (schema: JsonSchema) => ({
    description: "Created successfully",
    content: {
      "application/json": { schema: mutationResponse(schema) },
    },
  }),

  400: {
    description: "Bad Request",
    content: {
      "application/json": {
        schema: {
          ...errorResponseSchema,
          properties: {
            ...errorResponseSchema.properties,
            code: { type: "string", example: "VALIDATION_ERROR" },
            details: {
              type: "object",
              properties: {
                errors: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      field: { type: "string" },
                      message: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  401: {
    description: "Unauthorized",
    content: {
      "application/json": {
        schema: {
          ...errorResponseSchema,
          properties: {
            ...errorResponseSchema.properties,
            code: { type: "string", example: "UNAUTHORIZED" },
          },
        },
      },
    },
  },

  403: {
    description: "Forbidden",
    content: {
      "application/json": {
        schema: {
          ...errorResponseSchema,
          properties: {
            ...errorResponseSchema.properties,
            code: { type: "string", example: "FORBIDDEN" },
          },
        },
      },
    },
  },

  404: {
    description: "Not Found",
    content: {
      "application/json": {
        schema: {
          ...errorResponseSchema,
          properties: {
            ...errorResponseSchema.properties,
            code: { type: "string", example: "NOT_FOUND" },
          },
        },
      },
    },
  },

  409: {
    description: "Conflict",
    content: {
      "application/json": {
        schema: {
          ...errorResponseSchema,
          properties: {
            ...errorResponseSchema.properties,
            code: { type: "string", example: "CONFLICT" },
          },
        },
      },
    },
  },

  500: {
    description: "Internal Server Error",
    content: {
      "application/json": {
        schema: {
          ...errorResponseSchema,
          properties: {
            ...errorResponseSchema.properties,
            code: { type: "string", example: "INTERNAL_ERROR" },
          },
        },
      },
    },
  },
};

// ============================================================================
// Query Parameter Schemas
// ============================================================================

export const queryParams = {
  pagination: {
    page: {
      type: "integer",
      minimum: 1,
      default: 1,
      description: "Page number",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 20,
      description: "Items per page",
    },
  },

  sorting: {
    sort: {
      type: "string",
      description: "Sort field (prefix with - for descending)",
      example: "-createdAt",
    },
  },

  filtering: {
    select: {
      description: "Fields to include (space-separated or object)",
      example: "name email createdAt",
    },
    populate: {
      description: "Relations to populate (comma-separated string or bracket-notation object)",
      example: "author,category",
    },
  },
};

/**
 * Get standard list query parameters schema
 */
export function getListQueryParams(): AnyRecord {
  return {
    type: "object",
    properties: {
      ...queryParams.pagination,
      ...queryParams.sorting,
      ...queryParams.filtering,
    },
    // Allow additional/complex query params (e.g., bracket-notation populate, filters)
    // Without this, qs-parsed nested objects like ?populate[author][select]=name would be rejected
    additionalProperties: true,
  };
}

// ============================================================================
// Default CRUD Schemas
// ============================================================================

/**
 * Generic item schema that allows any properties.
 * Used as default when no user schema is provided.
 * Enables fast-json-stringify while still passing through all fields.
 */
const genericItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: true,
};

/**
 * Recursively strip `example` keys from a schema object.
 * The `example` keyword is OpenAPI metadata — not standard JSON Schema —
 * and triggers Ajv strict mode errors when used on routes without the
 * `keywords: ['example']` AJV config (e.g., raw Fastify without createApp).
 */
function stripExamples<T>(schema: T): T {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripExamples) as T;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "example") continue;
    result[key] = stripExamples(value);
  }
  return result as T;
}

/**
 * Get default response schemas for all CRUD operations.
 *
 * When routes have response schemas, Fastify compiles them with
 * fast-json-stringify for 2-3x faster serialization and prevents
 * accidental field disclosure.
 *
 * These defaults use `additionalProperties: true` so all fields pass through.
 * Override with specific schemas for full serialization performance + safety.
 *
 * Note: `example` properties are stripped from defaults so they work with
 * any Fastify instance (not just createApp which adds `keywords: ['example']`).
 */
export function getDefaultCrudSchemas(): Record<string, Record<string, unknown>> {
  return stripExamples({
    list: {
      querystring: getListQueryParams(),
      response: { 200: listResponse(genericItemSchema) },
    },
    get: {
      response: { 200: itemResponse(genericItemSchema) },
    },
    create: {
      response: { 201: mutationResponse(genericItemSchema) },
    },
    update: {
      response: { 200: itemResponse(genericItemSchema) },
    },
    delete: {
      response: { 200: deleteResponse() },
    },
  });
}
