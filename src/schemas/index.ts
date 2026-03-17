/**
 * Arc Schema Utilities — TypeBox Integration
 *
 * Provides type-safe schema definitions for Fastify routes using TypeBox.
 * Install `@sinclair/typebox` and `@fastify/type-provider-typebox` to use.
 *
 * @example
 * ```typescript
 * import { Type, ArcListResponse, ArcPaginationQuery } from '@classytic/arc/schemas';
 *
 * const ItemSchema = Type.Object({
 *   _id: Type.String(),
 *   name: Type.String(),
 *   createdAt: Type.String({ format: 'date-time' }),
 * });
 *
 * // Use in route definitions
 * fastify.get('/items', {
 *   schema: {
 *     querystring: ArcPaginationQuery(),
 *     response: { 200: ArcListResponse(ItemSchema) },
 *   },
 * }, handler);
 * ```
 *
 * @module
 */

// Re-export TypeBox core — users import Type from here instead of @sinclair/typebox directly
export { Type } from '@sinclair/typebox';
export type { Static, TSchema, TObject } from '@sinclair/typebox';

// Re-export Fastify TypeBox type provider
export { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox';
export type { TypeBoxTypeProvider, FastifyPluginAsyncTypebox, FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';

import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';

// ============================================================================
// Arc Response Schemas (TypeBox versions of responseSchemas.ts)
// ============================================================================

/**
 * Paginated list response — matches Arc's runtime format:
 * `{ success, docs: [...], page, limit, total, pages, hasNext, hasPrev }`
 */
export function ArcListResponse<T extends TSchema>(itemSchema: T) {
  return Type.Object({
    success: Type.Boolean(),
    docs: Type.Array(itemSchema),
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
    pages: Type.Integer(),
    hasNext: Type.Boolean(),
    hasPrev: Type.Boolean(),
  });
}

/**
 * Single item response — `{ success, data: {...} }`
 */
export function ArcItemResponse<T extends TSchema>(itemSchema: T) {
  return Type.Object({
    success: Type.Boolean(),
    data: itemSchema,
  });
}

/**
 * Mutation (create/update) response — `{ success, data: {...}, message? }`
 */
export function ArcMutationResponse<T extends TSchema>(itemSchema: T) {
  return Type.Object({
    success: Type.Boolean(),
    data: itemSchema,
    message: Type.Optional(Type.String()),
  });
}

/**
 * Delete response — `{ success, message }`
 */
export function ArcDeleteResponse() {
  return Type.Object({
    success: Type.Boolean(),
    message: Type.Optional(Type.String()),
  });
}

/**
 * Error response schema
 */
export function ArcErrorResponse() {
  return Type.Object({
    success: Type.Literal(false),
    error: Type.String(),
    code: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  });
}

// ============================================================================
// Arc Query Schemas
// ============================================================================

/**
 * Standard pagination + sorting + filtering query parameters.
 * Matches Arc's list endpoint conventions.
 */
export function ArcPaginationQuery() {
  return Type.Object({
    page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    sort: Type.Optional(Type.String()),
    select: Type.Optional(Type.String()),
    populate: Type.Optional(Type.Any()),
  }, { additionalProperties: true });
}
