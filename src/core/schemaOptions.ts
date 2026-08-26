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
 * Drop `systemManaged` fields from `required[]` in generated body schemas.
 *
 * Arc populates those from scope / preset middleware / controller, so a client
 * never supplies them — but the DB schema may still mark them required, and the
 * adapter reflects that into the wire contract.
 *
 * THE GOTCHA THIS CLOSES: engines on `@classytic/primitives` default to
 * `tenant: { required: true }`, stamping `organizationId` as required. Fastify
 * preValidation runs BEFORE arc's preHandler chain, so the tenant-injection
 * hook never gets to run and the request dies on
 * `must have required property 'organizationId'` — even though the client sent
 * `x-organization-id` and arc had promised to inject it. The alternative was
 * `tenant: { required: false }` at every consumer site.
 *
 * Also covers `auditedPreset`'s `createdBy`/`updatedBy` and any host rule
 * marked `systemManaged`. Applies to create AND update, since update middleware
 * injects the same fields.
 *
 * `properties` is left INTACT — an elevated caller may still send these, and
 * `BodySanitizer` owns that runtime policy (`preserveForElevated`,
 * strip-vs-reject). No-op without `systemManaged` rules or generated schemas.
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
