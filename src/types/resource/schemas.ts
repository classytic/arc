/**
 * Schema-shaping types — `RouteSchemaOptions`, CRUD route schemas,
 * OpenAPI schema slots, the CRUD route-key union, and per-operation
 * middleware config.
 */

import type { SchemaBuilderOptions } from "@classytic/repo-core/schema";
import type { MiddlewareHandler } from "../fastify.js";
import type { ArcFieldRule } from "./fields.js";

/**
 * Schema-shaping options for a resource.
 *
 * Extends `@classytic/repo-core/schema`'s `SchemaBuilderOptions` so every
 * kit-generator callback typed against the repo-core contract
 * (mongokit's `buildCrudSchemasFromModel`, sqlitekit's
 * `buildCrudSchemasFromTable`, prismakit's equivalent) accepts arc's
 * options bag directly — no `as SchemaBuilderOptions` / `Parameters<...>[1]`
 * cast at the host wiring site.
 *
 * Inherited from `SchemaBuilderOptions`:
 *   - `strictAdditionalProperties` — emit `additionalProperties: false`
 *   - `dateAs` — `'date'` vs `'datetime'` ISO rendering
 *   - `softRequiredFields` — stay in `properties`, drop from `required[]`
 *   - `create: { omitFields, requiredOverrides, optionalOverrides, schemaOverrides }`
 *   - `update: { omitFields, requireAtLeastOne }`
 *   - `query: { filterableFields }` (kit-native filter declaration)
 *   - `openApiExtensions` — emit `x-*` vendor keywords for docgen
 *
 * Arc adds:
 *   - `fieldRules` with the richer `ArcFieldRule` per-entry shape
 *     (preserveForElevated, minLength/maxLength/min/max/pattern, enum,
 *     nullable, description) — arc's extensions are applied post-kit by
 *     `mergeFieldRuleConstraints`; the kit only sees the repo-core floor.
 *   - `hiddenFields` / `readonlyFields` / `requiredFields` / `optionalFields`
 *     / `excludeFields` — arc-only convenience lists that predate fieldRules.
 *     Keep using them if they're already in place; new code should prefer
 *     `fieldRules` for per-field control.
 *   - `filterableFields: string[]` — top-level list arc's MCP layer auto-
 *     derives from `QueryParser.allowedFilterFields`. Distinct from the
 *     inherited `query.filterableFields: Record<...>` which feeds the kit's
 *     list-query schema; nothing stops a resource from using both.
 *
 * **Why extend rather than duplicate**: mongokit's
 * `buildCrudSchemasFromModel(model, options: SchemaBuilderOptions)` is the
 * canonical callback shape. Before the extension, hosts wrote
 * `Parameters<typeof buildCrudSchemasFromModel>[1]` or
 * `as SchemaBuilderOptions` at every wiring site — a defensive cast with
 * no runtime effect. Extension locks the structural relationship at the
 * type layer so the cast is compile-verified gone.
 */
export interface RouteSchemaOptions extends SchemaBuilderOptions {
  hiddenFields?: string[];
  readonlyFields?: string[];
  requiredFields?: string[];
  optionalFields?: string[];
  excludeFields?: string[];
  /**
   * Fields allowed for filtering in list operations. MCP auto-derives
   * from `QueryParser.allowedFilterFields` when not set explicitly.
   *
   * Distinct from the inherited `query.filterableFields: Record<...>`
   * from `SchemaBuilderOptions` — that entry feeds the kit's list-query
   * JSON Schema; this one is arc's MCP-auto-derivation list.
   */
  filterableFields?: string[];
  /**
   * Per-field rules. Richer than repo-core's `FieldRules` — arc adds
   * `preserveForElevated`, constraint hints (`minLength`, `enum`,
   * `nullable`, etc.), and `description` on top of the four-flag floor
   * (`immutable`, `immutableAfterCreate`, `systemManaged`, `optional`).
   *
   * Structurally compatible: `Record<string, ArcFieldRule>` is assignable
   * to repo-core's `Record<string, FieldRule>` since `ArcFieldRule extends
   * FieldRule`. Kits see only the floor; arc's extensions are applied
   * post-kit by `mergeFieldRuleConstraints`.
   */
  fieldRules?: Record<string, ArcFieldRule>;
  /**
   * Query-time security whitelists + the kit's `filterableFields`.
   *
   * Extends repo-core's `SchemaBuilderOptions['query']` with arc-specific
   * runtime features that `QueryResolver` reads at request time:
   *
   * - **`allowedPopulate`** — populate-path whitelist consumed by
   *   `QueryResolver.sanitizePopulate` / `sanitizeAdvancedPopulate`.
   *   When set, only paths in the list pass through; everything else is
   *   stripped silently. Shrinks the auto-wired `?populate=` attack surface.
   *
   * - **`allowedLookups`** — lookup-collection whitelist consumed by
   *   `QueryResolver.sanitizeLookups`. When set, only the listed
   *   collections may be `$lookup`'d into the pipeline.
   *
   * Both are pre-2.11.2 runtime features — the type was missing them, so
   * hosts wrote `as Record<string, unknown>` at every call site. Arc's own
   * `QueryResolver` had to cast its own input via `as AnyRecord` for the
   * same reason. Adding the type dropped both casts.
   */
  query?: SchemaBuilderOptions["query"] & {
    /**
     * Populate-path whitelist. When set, `QueryResolver.sanitizePopulate`
     * strips any `?populate=<path>` not in this list. Omit to allow all
     * paths the kit recognizes.
     */
    allowedPopulate?: string[];
    /**
     * Lookup-collection whitelist for `QueryResolver.sanitizeLookups`.
     * When set, only the listed collections may be `$lookup`'d. Omit to
     * disable the whitelist (kit-level rules still apply).
     */
    allowedLookups?: string[];
  };
}

/**
 * CRUD route schemas (Fastify native format). Each slot accepts a plain
 * JSON Schema object **or** a Zod v4 schema — Arc's `convertRouteSchema`
 * feature-detects at runtime. Slot values are typed `unknown` so
 * class-based Zod schemas assign without casts.
 */
export interface CrudSchemas {
  /** GET / — list */
  list?: {
    querystring?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  /** GET /:id — get one */
  get?: {
    params?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  /** POST / — create */
  create?: {
    body?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  /** PATCH /:id — update */
  update?: {
    params?: unknown;
    body?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  /** DELETE /:id — delete */
  delete?: {
    params?: unknown;
    response?: Record<number, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenApiSchemas {
  entity?: unknown;
  createBody?: unknown;
  updateBody?: unknown;
  params?: unknown;
  listQuery?: unknown;
  /**
   * Explicit response schema for OpenAPI documentation. Auto-generated
   * from `createBody` if omitted. Does NOT affect Fastify serialization.
   */
  response?: unknown;
  [key: string]: unknown;
}

export type CrudRouteKey = "list" | "get" | "create" | "update" | "delete";

export interface MiddlewareConfig {
  list?: MiddlewareHandler[];
  get?: MiddlewareHandler[];
  create?: MiddlewareHandler[];
  update?: MiddlewareHandler[];
  delete?: MiddlewareHandler[];
  [key: string]: MiddlewareHandler[] | undefined;
}
