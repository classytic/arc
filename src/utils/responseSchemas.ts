/**
 * JSON Schema definitions for arc API responses.
 *
 * Wire shape (post-2.12): no envelope. HTTP status discriminates success
 * vs error. Success-path schemas describe the data shape directly; the
 * error path uses the canonical `ErrorContract` JSON Schema imported
 * from `@classytic/repo-core/errors` — single source of truth shared
 * with every other consumer in the org.
 */

import { errorContractSchema, errorDetailSchema } from "@classytic/repo-core/errors";
import type { AnyRecord } from "../types/index.js";

// ============================================================================
// Canonical error schemas — re-exported from repo-core
// ============================================================================
//
// Both constants are owned by `@classytic/repo-core/errors` (the canonical
// home for the `ErrorContract` + `ErrorDetail` interfaces and their
// runtime JSON-Schema spec). Arc re-exports for DX so hosts can import
// from `@classytic/arc/utils` alongside the rest of the response-schema
// helpers without learning the second import path.

export { errorContractSchema, errorDetailSchema };

// ============================================================================
// Schema Types
// ============================================================================

export interface JsonSchema {
  /**
   * Optional because JSON Schema allows top-level combinator-only schemas
   * (`{ oneOf: [...] }`, `{ anyOf: [...] }`, `{ allOf: [...] }`) — see
   * `listResponse()`, which emits a `oneOf` of the four canonical list
   * shapes with no top-level `type`.
   */
  type?: string | string[];
  properties?: Record<string, JsonSchema | AnyRecord>;
  required?: string[];
  items?: JsonSchema | AnyRecord;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  example?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  [key: string]: unknown;
}

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
//
// Single-doc responses (`get` / `create` / `update`) DON'T have a builder
// — the doc IS the response (no envelope; HTTP status discriminates).
// Pass your doc schema directly to Fastify's `response: { 200: schema }`
// slot. If you need Fastify to accept extra fields, set
// `additionalProperties: true` on your schema. Pre-2.13 `wrapResponse` /
// `itemResponse` / `mutationResponse` were three names for one trivial
// `{ ...schema, additionalProperties: true }` spread; deleted in the
// post-2.13 cleanup.

/**
 * List response schema — full union of every wire shape `toCanonicalList`
 * can emit. Hosts who know their endpoint only ever produces one variant
 * can pin to a narrower helper:
 *   - `offsetListResponse(item)` — `{ method: 'offset', data, page, limit, total, pages, hasNext, hasPrev }`
 *   - `keysetListResponse(item)` — `{ method: 'keyset', data, limit, hasMore, next: string|null }`
 *   - `aggregateListResponse(item)` — `{ method: 'aggregate', ...offset fields }`
 *   - `bareListResponse(item)` — `{ data }`
 *
 * The default `listResponse(item)` is the union (`oneOf`) of all four so
 * Fastify validation accepts any canonical kit shape — pre-2.13 this only
 * modelled offset and rejected keyset/aggregate/bare lists at the
 * response-schema gate.
 */
export function listResponse(itemSchema: JsonSchema): JsonSchema {
  return {
    oneOf: [
      offsetListResponse(itemSchema),
      keysetListResponse(itemSchema),
      aggregateListResponse(itemSchema),
      bareListResponse(itemSchema),
    ],
  };
}

/** Offset variant — `{ method: 'offset', data, page, limit, total, pages, hasNext, hasPrev }`. */
export function offsetListResponse(itemSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      method: { type: "string", const: "offset", example: "offset" },
      data: { type: "array", items: itemSchema },
      page: { type: "integer", example: 1 },
      limit: { type: "integer", example: 20 },
      total: { type: "integer", example: 100 },
      pages: { type: "integer", example: 5 },
      hasNext: { type: "boolean", example: false },
      hasPrev: { type: "boolean", example: false },
    },
    required: ["method", "data", "page", "limit", "total", "pages", "hasNext", "hasPrev"],
    additionalProperties: true,
  };
}

/** Keyset variant — `{ method: 'keyset', data, limit, hasMore, next: string | null }`. */
export function keysetListResponse(itemSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      method: { type: "string", const: "keyset", example: "keyset" },
      data: { type: "array", items: itemSchema },
      limit: { type: "integer", example: 20 },
      hasMore: { type: "boolean", example: true },
      next: { type: ["string", "null"], description: "Cursor token for the next page, or null." },
    },
    required: ["method", "data", "limit", "hasMore", "next"],
    additionalProperties: true,
  };
}

/** Aggregate variant — same shape as offset, discriminated by `method: 'aggregate'`. */
export function aggregateListResponse(itemSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      method: { type: "string", const: "aggregate", example: "aggregate" },
      data: { type: "array", items: itemSchema },
      page: { type: "integer" },
      limit: { type: "integer" },
      total: { type: "integer" },
      pages: { type: "integer" },
      hasNext: { type: "boolean" },
      hasPrev: { type: "boolean" },
    },
    required: ["method", "data", "page", "limit", "total", "pages", "hasNext", "hasPrev"],
    additionalProperties: true,
  };
}

/** Bare variant — `{ data }`, no `method` discriminant. */
export function bareListResponse(itemSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { data: { type: "array", items: itemSchema } },
    required: ["data"],
    additionalProperties: true,
  };
}

/** Delete response — flat shape mirroring the canonical delete envelope. */
export function deleteResponse(): JsonSchema {
  return {
    type: "object",
    properties: {
      message: { type: "string", example: "Deleted successfully" },
      id: { type: "string", example: "507f1f77bcf86cd799439011" },
      soft: { type: "boolean", example: false },
    },
    additionalProperties: true,
  };
}

// ============================================================================
// HTTP Status Response Schemas
// ============================================================================

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** Build an OpenAPI response entry for an `ErrorContract` at the given status. */
function errorResponse(status: number) {
  return {
    description: ERROR_DESCRIPTIONS[status] ?? "Error",
    content: {
      "application/json": { schema: errorContractSchema },
    },
  };
}

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
      "application/json": { schema: { ...schema, additionalProperties: true } },
    },
  }),

  400: errorResponse(400),
  401: errorResponse(401),
  403: errorResponse(403),
  404: errorResponse(404),
  409: errorResponse(409),
  500: errorResponse(500),
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
    // `genericItemSchema` already carries `additionalProperties: true`,
    // so single-doc routes get the same permissive shape the deleted
    // `itemResponse` / `mutationResponse` aliases used to stamp.
    get: { response: { 200: genericItemSchema } },
    create: { response: { 201: genericItemSchema } },
    update: { response: { 200: genericItemSchema } },
    delete: { response: { 200: deleteResponse() } },
  });
}
