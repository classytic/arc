/**
 * Canonical wire-shape schemas — defined ONCE in `components.schemas`
 * and referenced (`$ref`) from every path that emits the shape.
 *
 * These mirror the runtime contracts arc 2.13 actually emits:
 *   - `ErrorContract` / `ErrorDetail` from `@classytic/repo-core/errors`
 *     (what `errorHandlerPlugin` serializes for every 4xx/5xx).
 *   - `DeleteResult` — arc's actual delete wire shape `{ message, id?, soft? }`
 *     (NOT repo-core's internal type-name `DeleteResult` — see the
 *     "arc-specific extension" note below).
 *   - `OffsetPaginationResult` / `KeysetPaginationResult` /
 *     `AggregatePaginationResult` / `BareListResult` from
 *     `@classytic/repo-core/pagination` — the four shapes arc's
 *     `toCanonicalList` produces, branched via the top-level `method`
 *     discriminant. The bare shape lacks `method`; consumers narrow on
 *     its absence.
 *
 * NOTE on `DeleteResult` semantics: repo-core's `DeleteResult`
 * type-name is conceptually wider than what arc's HTTP DELETE handler
 * emits to the wire. The runtime wire shape (after
 * `BaseCrudController.delete`) is `{ message, id?, soft? }`. We model
 * THAT shape (the wire reality) here — repo-core's broader type is for
 * inter-package use, not codegen consumers.
 *
 * NOTE: we don't emit OpenAPI 3.0 `discriminator` on the paginated
 * `oneOf` because the bare list lacks the `method` property — a
 * `discriminator: { propertyName: "method" }` would be invalid.
 * Plain `oneOf` produces a clean TS union via `@hey-api/openapi-ts`.
 */

import type { SchemaObject } from "./types.js";

/**
 * Static canonical schemas — referenced once, from
 * `components.schemas`. Per-resource schemas (paginated `oneOf` with
 * the resource's `items.$ref`) are built via
 * `buildPaginatedListSchema(itemRef)` below.
 */
export const CANONICAL_SCHEMAS: Record<string, SchemaObject> = {
  ErrorDetail: {
    type: "object",
    required: ["code", "message"],
    description:
      "Single field-scoped error detail. Mirrors `@classytic/repo-core/errors` ErrorDetail.",
    properties: {
      path: {
        type: "string",
        description: "Dot-path pointer to the offending field (e.g. `lines.0.quantity`).",
      },
      code: { type: "string" },
      message: { type: "string" },
      meta: { type: "object", additionalProperties: true },
    },
  },
  ErrorContract: {
    type: "object",
    required: ["code", "message"],
    description:
      "Canonical error wire shape emitted by arc's error handler. Mirrors " +
      "`@classytic/repo-core/errors` ErrorContract — flat top-level " +
      "`code` / `message`, NOT nested under `{ error: { ... } }`.",
    properties: {
      code: {
        type: "string",
        description:
          "Hierarchical machine code (e.g. `not_found`, `validation_error`, " +
          "`order.validation.missing_line`). Arc's legacy UPPER_SNAKE codes " +
          "(`'NOT_FOUND'`, `'VALIDATION_ERROR'`) also flow through this field for back-compat.",
      },
      message: { type: "string", description: "Human-readable, safe-for-client message." },
      status: { type: "integer", description: "Suggested HTTP status code." },
      details: { type: "array", items: { $ref: "#/components/schemas/ErrorDetail" } },
      correlationId: { type: "string", description: "Trace identifier for support lookups." },
      meta: {
        type: "object",
        additionalProperties: true,
        description: "Non-PII metadata. Safe to log, safe to return.",
      },
    },
  },
  DeleteResult: {
    type: "object",
    required: ["message"],
    description:
      "Arc's HTTP DELETE wire shape. The handler returns `{ message, id?, soft? }` " +
      "(see `BaseCrudController.delete`). " +
      "// arc-specific extension to repo-core's DeleteResult TYPE — repo-core's " +
      "type carries internal `count?` for batch adapters that surface counts " +
      "inline; arc's HTTP handler does not project that to the wire. " +
      "// arc-specific extension: `meta` (e.g. `{ message: 'Deleted successfully' }`) " +
      "is merged at the top level by `fastifyAdapter` — `message` already covers " +
      "that, no second nesting.",
    properties: {
      message: { type: "string", description: "Human-readable success message." },
      id: { type: "string", description: "Primary key of the removed document (string form)." },
      soft: {
        type: "boolean",
        description: "True when a soft-delete plugin intercepted the operation.",
      },
    },
  },
};

/**
 * Build the per-resource paginated list response schema as a plain
 * `oneOf` of the four canonical list envelopes:
 *
 *   - offset (`{ method: 'offset', data, page, limit, total, pages, hasNext, hasPrev }`)
 *   - keyset (`{ method: 'keyset', data, limit, hasMore, next }`)
 *   - aggregate (`{ method: 'aggregate', data, page, limit, total, pages, hasNext, hasPrev }`)
 *   - bare    (`{ data }`)
 *
 * The first three carry the `method` literal as a discriminant string;
 * codegen tools narrow on `method`. Bare lacks `method` — consumers
 * narrow on its absence.
 *
 * NOTE on shape parity with repo-core/pagination/types.ts:
 *   - Keyset uses `hasMore` (boolean) + `next: string | null` — see
 *     `KeysetPaginationResultCore`. We model `next` as nullable string.
 *   - Offset/aggregate are structurally identical save for the
 *     `method` literal (the discriminant exists so consumers can route
 *     "this came from an aggregate, not a plain find").
 */
export function buildPaginatedListSchema(itemRef: string): SchemaObject {
  return {
    description:
      "List response — discriminated union of arc's four canonical list shapes. " +
      "Branch on `method` (`'offset' | 'keyset' | 'aggregate'`) for paginated " +
      "results; absence of `method` indicates a bare (unpaginated) list.",
    oneOf: [
      {
        type: "object",
        required: ["method", "data", "page", "limit", "total", "pages", "hasNext", "hasPrev"],
        description: "Offset-paginated result.",
        properties: {
          method: { type: "string", enum: ["offset"] },
          data: { type: "array", items: { $ref: itemRef } },
          page: { type: "integer" },
          limit: { type: "integer" },
          total: { type: "integer" },
          pages: { type: "integer" },
          hasNext: { type: "boolean" },
          hasPrev: { type: "boolean" },
        },
      },
      {
        type: "object",
        required: ["method", "data", "limit", "hasMore", "next"],
        description: "Keyset-paginated result.",
        properties: {
          method: { type: "string", enum: ["keyset"] },
          data: { type: "array", items: { $ref: itemRef } },
          limit: { type: "integer" },
          hasMore: { type: "boolean" },
          next: {
            type: "string",
            // OpenAPI 3.0 doesn't support type-arrays; `nullable: true` is the
            // 3.0 form. Codegen tools (`@hey-api/openapi-ts`, `openapi-generator`)
            // translate this to `string | null`. The 3.1 form would be
            // `type: ["string", "null"]` but arc emits 3.0.3.
            nullable: true,
            description:
              "Opaque cursor for the next page, or null when `hasMore` is false. " +
              "Round-trip verbatim as the `after` query param.",
          },
        },
      },
      {
        type: "object",
        required: ["method", "data", "page", "limit", "total", "pages", "hasNext", "hasPrev"],
        description: "Aggregate-paginated result.",
        properties: {
          method: { type: "string", enum: ["aggregate"] },
          data: { type: "array", items: { $ref: itemRef } },
          page: { type: "integer" },
          limit: { type: "integer" },
          total: { type: "integer" },
          pages: { type: "integer" },
          hasNext: { type: "boolean" },
          hasPrev: { type: "boolean" },
        },
      },
      {
        type: "object",
        required: ["data"],
        description: "Bare (unpaginated) list — `{ data: T[] }` only.",
        properties: {
          data: { type: "array", items: { $ref: itemRef } },
        },
      },
    ],
  };
}
