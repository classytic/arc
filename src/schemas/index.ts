/**
 * Arc Schema Utilities — TypeBox Integration
 *
 * Provides type-safe schema definitions for Fastify routes using TypeBox.
 * Install `typebox` (v1) and `@fastify/type-provider-typebox` (v6) to use.
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

// Compile-time typed plugin/route boundaries only — arc uses Fastify's
// standard AJV validator at runtime, NOT TypeBoxValidatorCompiler. These are
// TYPES; import them (or `@fastify/type-provider-typebox` directly) to get
// `Type.*`-schema inference in your handlers.
export type {
  FastifyPluginAsyncTypebox,
  FastifyPluginCallbackTypebox,
  TypeBoxTypeProvider,
} from "@fastify/type-provider-typebox";
export type { Static, TObject, TSchema } from "typebox";
// Re-export TypeBox core — users import Type from here instead of `typebox` directly
export { Type } from "typebox";

import {
  type ErrorContract,
  type ErrorDetail,
  errorContractSchema,
  errorDetailSchema,
} from "@classytic/repo-core/errors";
import type { TSchema } from "typebox";
import { Type } from "typebox";

// ============================================================================
// Arc Response Schemas (TypeBox versions of responseSchemas.ts)
// ============================================================================

/**
 * Paginated list response — full union of every wire shape `toCanonicalList`
 * emits. Mirrors `PaginatedResult<T>` from `@classytic/repo-core/pagination`:
 *
 *   - `{ method: 'offset', data, page, limit, total, pages, hasNext, hasPrev }`
 *   - `{ method: 'keyset', data, limit, hasMore, next: string | null }`
 *   - `{ method: 'aggregate', ...same as offset }`
 *   - `{ data }` (bare list, no `method`)
 *
 * Use `ArcOffsetListResponse` / `ArcKeysetListResponse` /
 * `ArcAggregateListResponse` / `ArcBareListResponse` to pin a single
 * variant when your endpoint never emits the others. HTTP status
 * discriminates success vs error — no `success` field.
 */
export function ArcListResponse<T extends TSchema>(itemSchema: T) {
  return Type.Union([
    ArcOffsetListResponse(itemSchema),
    ArcKeysetListResponse(itemSchema),
    ArcAggregateListResponse(itemSchema),
    ArcBareListResponse(itemSchema),
  ]);
}

/** Offset variant — `{ method: 'offset', data, page, limit, total, pages, hasNext, hasPrev }`. */
export function ArcOffsetListResponse<T extends TSchema>(itemSchema: T) {
  return Type.Object({
    method: Type.Literal("offset"),
    data: Type.Array(itemSchema),
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
    pages: Type.Integer(),
    hasNext: Type.Boolean(),
    hasPrev: Type.Boolean(),
  });
}

/** Keyset variant — `{ method: 'keyset', data, limit, hasMore, next: string | null }`. */
export function ArcKeysetListResponse<T extends TSchema>(itemSchema: T) {
  return Type.Object({
    method: Type.Literal("keyset"),
    data: Type.Array(itemSchema),
    limit: Type.Integer(),
    hasMore: Type.Boolean(),
    next: Type.Union([Type.String(), Type.Null()]),
  });
}

/** Aggregate variant — `{ method: 'aggregate', ...same as offset }`. */
export function ArcAggregateListResponse<T extends TSchema>(itemSchema: T) {
  return Type.Object({
    method: Type.Literal("aggregate"),
    data: Type.Array(itemSchema),
    page: Type.Integer(),
    limit: Type.Integer(),
    total: Type.Integer(),
    pages: Type.Integer(),
    hasNext: Type.Boolean(),
    hasPrev: Type.Boolean(),
  });
}

/** Bare variant — `{ data }`, no `method` discriminant. */
export function ArcBareListResponse<T extends TSchema>(itemSchema: T) {
  return Type.Object({
    data: Type.Array(itemSchema),
  });
}

// Single-doc responses (`get` / `create` / `update`) DON'T have helpers —
// the doc IS the response (no envelope; HTTP status discriminates). Pass
// your TypeBox schema directly to the route's `response: { 200: schema }`
// slot. Pre-2.13 `ArcItemResponse` / `ArcMutationResponse` were identity
// functions (`(x) => x`); deleted in the post-2.13 cleanup.

/**
 * Delete response — `{ message, id?, soft? }` raw at the top level.
 */
export function ArcDeleteResponse() {
  return Type.Object({
    message: Type.String(),
    id: Type.Optional(Type.String()),
    soft: Type.Optional(Type.Boolean()),
  });
}

/**
 * Single field-scoped error detail — `Type.Unsafe<ErrorDetail>` over the
 * canonical JSON Schema `errorDetailSchema` from
 * `@classytic/repo-core/errors`. One schema constant, two adapters
 * (JSON-Schema + TypeBox), zero drift surface — the schema and the TS
 * type both come from repo-core.
 *
 * Exported standalone so hosts can embed it in custom 422 / 409 response
 * schemas.
 */
export function ArcErrorDetail() {
  return Type.Unsafe<ErrorDetail>(errorDetailSchema);
}

/**
 * Error response schema — `Type.Unsafe<ErrorContract>` over the canonical
 * JSON Schema `errorContractSchema` from `@classytic/repo-core/errors`.
 * Same trick as `ArcErrorDetail`: the schema bytes and the TS type both
 * come from repo-core, so the JSON-Schema sibling
 * (`errorContractSchema`) and this TypeBox helper cannot drift —
 * literally one source.
 */
export function ArcErrorResponse() {
  return Type.Unsafe<ErrorContract>(errorContractSchema);
}

// ============================================================================
// Arc Query Schemas
// ============================================================================

/**
 * Standard pagination + sorting + filtering query parameters.
 * Matches Arc's list endpoint conventions.
 *
 * `select` accepts every shape `QueryResolver` preserves DB-agnostically
 * (gotcha #5):
 *
 *   - `string`  — `"name email -password"` (Mongoose space-separated)
 *   - `string[]` — `["name", "email", "-password"]` (Arc parser)
 *   - `Record<string, 0 | 1>` — `{ name: 1, email: 1, password: 0 }` (Mongo projection)
 *
 * Narrowing `select` to `string` would have rejected the array and
 * projection forms at the request-validation gate even though arc passes
 * them through unchanged.
 */
export function ArcPaginationQuery() {
  return Type.Object(
    {
      page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
      sort: Type.Optional(Type.String()),
      select: Type.Optional(
        Type.Union([
          Type.String(),
          Type.Array(Type.String()),
          Type.Record(Type.String(), Type.Union([Type.Literal(0), Type.Literal(1)])),
        ]),
      ),
      populate: Type.Optional(Type.Any()),
    },
    { additionalProperties: true },
  );
}
