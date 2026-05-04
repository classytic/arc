/**
 * Shared helpers used across crud-tools, route-tools, and action-tools.
 *
 * Kept thin and side-effect-free. If a helper starts growing domain
 * knowledge (CRUD-specific, route-specific, action-specific), it should
 * move into the matching *-tools.ts file instead.
 */

import type { ErrorContract } from "@classytic/repo-core/errors";
import { isHttpError, toErrorContract } from "@classytic/repo-core/errors";
import type { FastifyRequest } from "fastify";
import { BaseController } from "../../core/BaseController.js";
import type { ResourceDefinition } from "../../core/defineResource.js";
import { normalizePermissionResult } from "../../permissions/applyPermissionResult.js";
import type { PermissionCheck, PermissionResult } from "../../permissions/types.js";
import type { IControllerResponse } from "../../types/index.js";
import { isArcError } from "../../utils/errors.js";
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
 *
 * Errors are not represented here — controllers throw `ArcError` and the
 * MCP tool wrapper catches them via {@link toCallToolError}.
 */
export function toCallToolResult(result: IControllerResponse): CallToolResult {
  const output = result.meta ? { data: result.data, ...result.meta } : result.data;
  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

/**
 * Wrap a raw success payload as an MCP `CallToolResult`. Use when the
 * tool produced a value directly (action handler return, aggregation
 * rows, etc.) instead of an `IControllerResponse` envelope.
 *
 * Emits the value as JSON with no envelope — same no-envelope contract
 * the HTTP wire follows. The `isError: true` flag on `CallToolResult`
 * is the success/error discriminant for MCP, mirroring HTTP status.
 */
export function toCallToolSuccess(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * Wrap an error as an MCP `CallToolResult` with the canonical
 * `ErrorContract` shape inside the text payload. Single source of truth
 * for MCP error serialization — every tool surface (CRUD, action, route,
 * aggregation) routes through here so the JSON shape an agent sees is
 * identical to what an HTTP client sees.
 *
 * Accepts:
 *  - An `ArcError` (or any `HttpError`-shaped throw) → routes through
 *    `toErrorContract()` for the canonical conversion.
 *  - A partial contract `{code, message, status, details?}` → used as-is.
 *  - Any other `Error` → falls back to `arc.internal_error` 500.
 */
export function toCallToolError(
  input:
    | Error
    | { code: string; message: string; status?: number; details?: ErrorContract["details"] },
): CallToolResult {
  let contract: ErrorContract;
  if (input instanceof Error) {
    if (isArcError(input) || isHttpError(input)) {
      contract = toErrorContract(input);
    } else {
      contract = {
        code: "arc.internal_error",
        message: input.message || "Internal Server Error",
        status: 500,
      };
    }
  } else {
    contract = {
      code: input.code,
      message: input.message,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.details ? { details: input.details } : {}),
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(contract) }],
    isError: true,
  };
}

/**
 * Build the canonical permission-denied `CallToolResult` for an MCP
 * tool. Discriminates 401 (no session — "Authentication required") from
 * 403 (session present, denied — "Permission denied"). Mirrors the
 * status split the HTTP `errorHandler` plugin uses.
 */
export function permissionDeniedResult(args: {
  resource: string;
  operation: string;
  reason?: string;
  session: McpAuthResult | null;
}): CallToolResult {
  const authenticated = args.session != null;
  return toCallToolError({
    code: authenticated ? "arc.forbidden" : "arc.unauthorized",
    message:
      args.reason ??
      (authenticated
        ? `Permission denied for '${args.operation}' on '${args.resource}'`
        : "Authentication required"),
    status: authenticated ? 403 : 401,
  });
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
