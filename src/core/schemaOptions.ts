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
