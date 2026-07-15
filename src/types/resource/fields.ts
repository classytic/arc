/**
 * Field-rule types — arc's per-field constraint / visibility / security
 * layer on top of repo-core's 4-flag `FieldRule` floor.
 */

import type { FieldRule as RepoCoreFieldRule } from "@classytic/repo-core/schema";

/**
 * Per-field rule — arc's extension of repo-core's 4-field `FieldRule` floor
 * (`immutable`, `immutableAfterCreate`, `systemManaged`, `optional`) with
 * the constraint / UI / security bits arc layers on top.
 *
 * Kept structurally compatible with `@classytic/repo-core/schema`'s
 * `FieldRule` so arc's `fieldRules: Record<string, ArcFieldRule>` flows
 * into mongokit's / sqlitekit's `buildCrudSchemasFromModel(..., options)`
 * without a cast. See `RouteSchemaOptions` JSDoc for the full rationale.
 */
export interface ArcFieldRule extends RepoCoreFieldRule {
  /**
   * When `true`, bypass the `systemManaged` / `readonly` / `immutable`
   * strip in `BodySanitizer` for callers whose request scope is
   * `elevated`. Lets platform admins stamp the value from the request
   * body — needed for cross-tenant admin writes where the tenant field
   * is the only way to pick a target org.
   *
   * Auto-set by `defineResource` on the configured `tenantField`. Hosts
   * can set it manually on other fields (e.g. `createdBy`) if they want
   * elevation-only override semantics for those too.
   *
   * Has no effect when `isElevated(scope)` is false — member and
   * service callers continue to have the field stripped.
   */
  preserveForElevated?: boolean;
  hidden?: boolean;
  /**
   * Aggregation visibility override. By default, only `hidden: true`
   * blocks a field from `groupBy` / `measures.field` / `sort` / `dateBuckets`
   * — that's the genuine cardinality-leak guard (the value is omitted from
   * list/get responses, so exposing it via aggregation would reveal data
   * the client can't otherwise see).
   *
   * `systemManaged: true` does **not** block aggregation — it's a write
   * rule, not a visibility rule. Server-stamped fields like `createdAt`,
   * `status`, or plugin-generated handles are visible in every list
   * response and should aggregate freely.
   *
   * Use this flag to override the default:
   *
   * - `aggregable: false` — explicit deny, even on visible fields. Useful
   *   when a value is exposed per-row but the cardinality across rows is
   *   itself sensitive (e.g. `email` is visible in `get/:id` to admins
   *   but you don't want a public-readable agg of email distributions).
   * - `aggregable: true` — escape hatch on `hidden` fields. Lets you
   *   aggregate a hidden column when you're sure cardinality leakage
   *   isn't a concern (e.g. `internalScore` hidden from list, but a
   *   committee-only `byScore` agg is fine).
   *
   * Defaults to `undefined` (use the `hidden`-only rule).
   */
  aggregable?: boolean;
  /** String minimum length — auto-maps to OpenAPI `minLength` and MCP tool schema */
  minLength?: number;
  /** String maximum length — auto-maps to OpenAPI `maxLength` and MCP tool schema */
  maxLength?: number;
  /** Number minimum — auto-maps to OpenAPI `minimum` and MCP tool schema */
  min?: number;
  /** Number maximum — auto-maps to OpenAPI `maximum` and MCP tool schema */
  max?: number;
  /** Regex pattern — auto-maps to OpenAPI `pattern` and MCP tool schema */
  pattern?: string;
  /** Allowed values — auto-maps to OpenAPI `enum` and MCP tool schema */
  enum?: ReadonlyArray<string | number>;
  /**
   * When `true`, widen the JSON Schema `type` of this field to also
   * accept `null`. Mirrors Zod's `.nullable()` at the arc config layer
   * for kit-generated schemas that don't carry the flag end-to-end
   * (e.g. Zod → Mongoose → mongokit drops `.nullable()` because
   * Mongoose has no first-class nullable marker unless `default: null`
   * is also set).
   *
   * Applied post-kit by `mergeFieldRuleConstraints`: if the adapter
   * emitted `{ type: 'string', enum: [...] }` for a field arc should
   * accept null for, the merge widens it to
   * `{ type: ['string', 'null'], enum: [...] }` — draft-7 tuple form
   * AJV 8 validates natively.
   *
   * No-op when the property already declares `type: [...,'null']` or
   * an `anyOf: [..., { type: 'null' }]` branch — arc never fights the
   * kit's own output.
   */
  nullable?: boolean;
  /** Human-readable description — auto-maps to OpenAPI `description` */
  description?: string;
  [key: string]: unknown;
}

export interface FieldRule {
  field: string;
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
}
