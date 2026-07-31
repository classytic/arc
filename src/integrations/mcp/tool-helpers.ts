/**
 * Shared helpers used across crud-tools, route-tools, and action-tools.
 *
 * Kept thin and side-effect-free. If a helper starts growing domain
 * knowledge (CRUD-specific, route-specific, action-specific), it should
 * move into the matching *-tools.ts file instead.
 */

import type { ErrorContract } from "@classytic/repo-core/errors";
import { isHttpError, toErrorContract } from "@classytic/repo-core/errors";
import { BaseController } from "../../core/BaseController.js";
import type { ResourceDefinition } from "../../core/defineResource.js";
import { evaluatePermissionDecision } from "../../permissions/authorizationDecision.js";
import {
  applyFieldReadPermissions,
  type FieldPermissionMap,
  resolveEffectiveRoles,
} from "../../permissions/fields.js";
import type { AuthorizationDecision, PermissionCheck } from "../../permissions/types.js";
import { isElevated, isMember, type RequestScope } from "../../scope/types.js";
import type { IControllerResponse } from "../../types/index.js";
import { isArcError } from "../../utils/errors.js";
import { buildScope } from "./buildRequestContext.js";
import type { CallToolResult, McpAuthResult } from "./types.js";

/**
 * Evaluate a resource's permission check in MCP context.
 *
 * Returns the full normalized {@link AuthorizationDecision} so the caller can
 * honor ALL side-effects (data policy + scope) consistently with CRUD/action
 * routes. Returns `null` when no permission is defined (= allow, no side effects).
 *
 * This is the MCP transport adapter: it builds a `PermissionContext` from the
 * MCP session and delegates the actual decision to the ONE transport-neutral
 * `evaluatePermissionDecision` — same normalization + exception mapping every
 * surface uses, so MCP enforcement can't drift from HTTP/aggregation.
 */
export async function evaluatePermission(
  check: PermissionCheck | undefined,
  session: McpAuthResult | null,
  resource: string,
  action: string,
  input: Record<string, unknown>,
): Promise<AuthorizationDecision | null> {
  if (!check) return null;

  const user = session ? { id: session.userId, _id: session.userId, ...session } : null;

  // MCP has NO Fastify request (arc 2.30, P6). It builds a transport-neutral
  // PermissionContext directly: `scope` (first-class, from the session) is the
  // identity channel `scopeOf(ctx)` reads, and `data` carries the tool input.
  // No synthetic request — built-in permissions depend only on these facts.
  return evaluatePermissionDecision(check, {
    user,
    scope: buildScope(session),
    resource,
    action,
    resourceId: typeof input.id === "string" ? input.id : undefined,
    params: {},
    data: input,
  });
}

/**
 * Apply field-level READ permissions to an MCP tool payload — the same
 * masking `sendControllerResponse` applies on the HTTP wire and the
 * realtime plugin applies per frame. Without this, a resource declaring
 * `fields: { salary: fields.visibleTo(['admin']) }` masked salary over
 * REST and SSE but leaked it verbatim through every MCP tool.
 *
 * Mirrors the HTTP adapter's semantics exactly:
 *  - Elevated scope (platform admin) bypasses masking — consistent with
 *    `requireOrgRole()` and `BodySanitizer` bypass logic.
 *  - Effective roles = session roles ∪ org roles (member scope only),
 *    via the shared `resolveEffectiveRoles`.
 *  - `scopeOverride` (a decision's `scope`) follows the same
 *    non-downgrade rule as `buildRequestContext`: honored only when the
 *    session-derived scope is `public`.
 *
 * Handles the three payload shapes MCP tools emit: a single record, an
 * array of records, and a paginated result object carrying an inner
 * `data: T[]`. Scalars and `null` pass through untouched.
 */
export function applyMcpReadMasking<T>(
  data: T,
  options: {
    fields: FieldPermissionMap | undefined;
    session: McpAuthResult | null;
    scopeOverride?: RequestScope;
  },
): T {
  const { fields, session, scopeOverride } = options;
  if (!fields || data === null || typeof data !== "object") return data;

  const sessionScope = buildScope(session);
  const scope: RequestScope =
    scopeOverride && sessionScope.kind === "public" ? scopeOverride : sessionScope;
  if (isElevated(scope)) return data;

  const roles = resolveEffectiveRoles(session?.roles ?? [], isMember(scope) ? scope.orgRoles : []);
  const maskItem = <I>(item: I): I =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? (applyFieldReadPermissions(item as Record<string, unknown>, fields, roles) as I)
      : item;

  if (Array.isArray(data)) return data.map(maskItem) as T;

  // Paginated list result — kits return `{ data: T[], ...pageMeta }`.
  const inner = (data as Record<string, unknown>).data;
  if (Array.isArray(inner)) {
    return { ...data, data: inner.map(maskItem) };
  }
  return maskItem(data);
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
