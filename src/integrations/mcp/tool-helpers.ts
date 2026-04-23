/**
 * Shared helpers used across crud-tools, route-tools, and action-tools.
 *
 * Kept thin and side-effect-free. If a helper starts growing domain
 * knowledge (CRUD-specific, route-specific, action-specific), it should
 * move into the matching *-tools.ts file instead.
 */

import type { FastifyRequest } from "fastify";
import { BaseController } from "../../core/BaseController.js";
import type { ResourceDefinition } from "../../core/defineResource.js";
import { normalizePermissionResult } from "../../permissions/applyPermissionResult.js";
import type { PermissionCheck, PermissionResult } from "../../permissions/types.js";
import type { IControllerResponse } from "../../types/index.js";
import type { CallToolResult, McpAuthResult } from "./types.js";

/**
 * Evaluate a resource's permission check in MCP context.
 *
 * Returns the full normalized `PermissionResult` so the caller can honor
 * ALL side-effects (filters + scope) consistently with CRUD/action routes.
 * Returns `null` when no permission is defined (= allow, no side effects).
 *
 * Promoting booleans to `PermissionResult` via the shared
 * `normalizePermissionResult` helper keeps the contract aligned with the
 * rest of arc — one normalization path for every call site.
 */
export async function evaluatePermission(
  check: PermissionCheck | undefined,
  session: McpAuthResult | null,
  resource: string,
  action: string,
  input: Record<string, unknown>,
): Promise<PermissionResult | null> {
  if (!check) return null;

  const user = session ? { id: session.userId, _id: session.userId, ...session } : null;
  const fakeRequest = {
    user,
    headers: {},
    params: {},
    query: {},
    body: input,
  } as unknown as FastifyRequest;

  const result = await check({
    user,
    request: fakeRequest,
    resource,
    action,
    resourceId: typeof input.id === "string" ? input.id : undefined,
    params: {},
    data: input,
  });

  return normalizePermissionResult(result);
}

/**
 * Convert a controller response envelope into an MCP `CallToolResult`.
 * Carries `meta` into the serialized payload so consumers see pagination
 * totals, stripped-field arrays, etc.
 */
export function toCallToolResult(result: IControllerResponse): CallToolResult {
  if (!result.success) {
    return { content: [{ type: "text", text: result.error ?? "Operation failed" }], isError: true };
  }
  const output = result.meta ? { data: result.data, ...result.meta } : result.data;
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

/**
 * Auto-create a BaseController from the resource's adapter for MCP use.
 * Called when the resource has an adapter but no controller
 * (e.g. `disableDefaultRoutes: true` skips controller creation in
 * `defineResource`).
 */
export function createMcpController(resource: ResourceDefinition): unknown {
  const repository = resource.adapter?.repository;
  if (!repository) return undefined;

  return new BaseController(repository, {
    resourceName: resource.name,
    schemaOptions: resource.schemaOptions,
    tenantField: resource.tenantField,
    idField: resource.idField,
    matchesFilter: resource.adapter?.matchesFilter,
  });
}
