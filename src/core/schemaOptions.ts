/**
 * Shared utilities for `RouteSchemaOptions` manipulation.
 *
 * Extracted so every consumer that needs "the effective, post-preset,
 * post-auto-inject schemaOptions for a resource" goes through one
 * function. Prevents the bug class where adapters / MCP / OpenAPI
 * generators receive the RAW `config.schemaOptions` while runtime
 * sanitizers receive the resolved copy — which was the 2.10.6 half-
 * wired auto-inject regression.
 */

import type { RouteSchemaOptions } from "../types/index.js";

// ============================================================================
// Tenant field rule auto-injection
// ============================================================================

/**
 * Inject the tenant-scoping field rule into `schemaOptions.fieldRules`:
 *
 *   { [tenantField]: { systemManaged: true, preserveForElevated: true } }
 *
 * Why both flags: `systemManaged` tells `BodySanitizer` to strip the
 * field from inbound bodies (so member clients can't forge a target
 * tenant). `preserveForElevated` exempts elevated-admin scopes from the
 * strip, so platform admins without a pinned org can still pick a target
 * org via the request body (the only channel they have —
 * `BaseController.create` can't re-stamp from scope when scope has no
 * orgId).
 *
 * **Returns a new `RouteSchemaOptions`** — the input is never mutated.
 * Callers should assign the return value to whatever config slot they
 * read from downstream (always the `resolvedConfig`, never raw `config`).
 *
 * **No-op when:**
 * - `tenantField` is `false` (platform-universal resource)
 * - `tenantField` is undefined
 * - The caller already declared `fieldRules[tenantField].systemManaged`
 *   (even as `false`) — explicit opt-outs are respected
 *
 * `preserveForElevated` defaults to `true` but is preserved verbatim
 * when the caller set it explicitly.
 */
export function autoInjectTenantFieldRules(
  schemaOptions: RouteSchemaOptions | undefined,
  tenantField: string | false | undefined,
): RouteSchemaOptions | undefined {
  // No tenant scoping → nothing to inject. Return the original reference
  // so callers that want "schemaOptions or undefined" get exactly that.
  if (tenantField === false || tenantField === undefined) return schemaOptions;

  const fieldName = tenantField || "organizationId";
  const existing = schemaOptions?.fieldRules ?? {};
  const existingRule = existing[fieldName];

  // Explicit opt-out: if the host declared `systemManaged` on this field
  // (as true OR false), respect their choice and don't overwrite.
  if (existingRule && existingRule.systemManaged !== undefined) {
    return schemaOptions;
  }

  return {
    ...(schemaOptions ?? {}),
    fieldRules: {
      ...existing,
      [fieldName]: {
        ...(existingRule ?? {}),
        systemManaged: true,
        preserveForElevated: existingRule?.preserveForElevated ?? true,
      },
    },
  };
}

// ============================================================================
// Strip framework-injected fields from body schema `required[]`
// ============================================================================

type JsonSchemaLike = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [key: string]: unknown;
};

/**
 * Remove a field from a JSON Schema's `required[]` array. Leaves `properties`
 * intact so advanced callers can still send the value — the field just isn't
 * mandatory at validation time.
 *
 * Returns a fresh schema (no mutation). No-op when the schema is undefined,
 * lacks a `required[]`, or the field is already absent from it.
 */
function stripFromRequired(
  schema: JsonSchemaLike | undefined,
  fieldName: string,
): JsonSchemaLike | undefined {
  if (!schema || typeof schema !== "object") return schema;
  const required = schema.required;
  if (!Array.isArray(required) || !required.includes(fieldName)) return schema;

  const filtered = required.filter((f) => f !== fieldName);
  const next: JsonSchemaLike = { ...schema };
  if (filtered.length > 0) {
    next.required = filtered;
  } else {
    delete next.required;
  }
  return next;
}

/**
 * Strip framework-injected fields from the `required[]` list of every
 * body-shaped slot in an adapter's generated schemas (v2.11.0).
 *
 * A "framework-injected field" is any field marked `systemManaged: true`
 * in `schemaOptions.fieldRules`. Arc populates those fields from the
 * request scope / preset middleware / controller — the client is never
 * expected to supply them, so they must not be in the wire contract's
 * `required[]` even if the underlying engine's Mongoose/Zod schema
 * declares them as required at the DB layer.
 *
 * **The primary gotcha this closes:** engines built on
 * `@classytic/primitives` (mongokit, pricelist, and every downstream
 * `@classytic/*` engine) default to `tenant: { required: true }` in
 * `resolveTenantConfig()`. That stamps `organizationId: { required: true }`
 * on the Mongoose schema, which the adapter faithfully reflects into the
 * generated `createBody` / `updateBody` schema's `required[]`. Fastify's
 * preValidation runs BEFORE arc's preHandler chain, so
 * `multiTenantPreset`'s tenant-injection hook never gets a chance to run —
 * the request is rejected with `must have required property 'organizationId'`
 * even though the client correctly supplied `x-organization-id` and the
 * framework had already promised to inject the value.
 *
 * The only workaround before 2.11 was
 * `createEngine({ tenant: { required: false } })` at every consumer site —
 * a leaky abstraction every new engine-backed resource had to remember.
 *
 * **Secondary coverage (defense-in-depth):** the same transform also fires
 * for `auditedPreset`'s `createdBy` / `updatedBy`, any future preset that
 * marks fields `systemManaged`, and any host-declared `fieldRules` with
 * `systemManaged: true`. Every framework-injected field gets the wire
 * contract / runtime pairing for free.
 *
 * **Leaves `properties` intact** — elevated admins or advanced callers can
 * still send systemManaged fields in the body. `BodySanitizer` enforces
 * the runtime policy (`preserveForElevated`, `strip` vs `reject`, etc.).
 *
 * **No-op when:**
 * - `schemaOptions.fieldRules` is undefined / empty
 * - No rule has `systemManaged: true`
 * - The generated schemas object is undefined (adapter didn't generate any)
 *
 * Applies to both `createBody` and `updateBody` — update middleware also
 * injects tenant/audit fields, so the update wire contract has the same
 * problem as create.
 */
export function stripSystemManagedFromBodyRequired<
  T extends { createBody?: unknown; updateBody?: unknown } | undefined,
>(schemas: T, schemaOptions: RouteSchemaOptions | undefined): T {
  if (!schemas) return schemas;
  const rules = schemaOptions?.fieldRules;
  if (!rules) return schemas;

  const systemManagedFields = Object.entries(rules)
    .filter(([, rule]) => rule?.systemManaged === true)
    .map(([field]) => field);
  if (systemManagedFields.length === 0) return schemas;

  const next = { ...schemas } as Record<string, unknown>;

  let createBody = schemas.createBody as JsonSchemaLike | undefined;
  for (const field of systemManagedFields) {
    createBody = stripFromRequired(createBody, field);
  }
  if (createBody !== schemas.createBody) next.createBody = createBody;

  let updateBody = schemas.updateBody as JsonSchemaLike | undefined;
  for (const field of systemManagedFields) {
    updateBody = stripFromRequired(updateBody, field);
  }
  if (updateBody !== schemas.updateBody) next.updateBody = updateBody;

  return next as T;
}
