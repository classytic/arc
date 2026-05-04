/**
 * `Operation` factory + permission-annotation helpers.
 *
 * Every path's HTTP-method body comes from `createOperation` —
 * centralized so the security block, x-arc-permission extension,
 * pipeline-step extension, and shared error responses stay in one place.
 *
 * Default error responses ALL reference `ErrorContract` (the canonical
 * wire shape), replacing the legacy `Error` schema. Auth-gated routes
 * pick up `401` + `403`; every operation gets a `500`. Per-method
 * overrides come in via the `extras.responses` slot on each call site.
 */

import type { PermissionCheck } from "../../permissions/types.js";
import type { RegistryEntry } from "../../types/index.js";
import type { Operation, Response } from "./types.js";

/**
 * Standard error responses that every CRUD route ships. Per-route
 * additions (e.g. 404 on get/update/delete, 409 on create/update) are
 * merged on top via `extras.responses`.
 *
 * @internal
 */
export function buildErrorResponses(opts: {
  requiresAuth: boolean;
  permRoles?: readonly string[];
}): Record<string, Response> {
  const responses: Record<string, Response> = {};

  if (opts.requiresAuth) {
    responses["401"] = {
      description: "Authentication required — no valid Bearer token provided",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorContract" },
        },
      },
    };
    responses["403"] = {
      description: opts.permRoles?.length
        ? `Forbidden — requires one of: ${opts.permRoles.join(", ")}`
        : "Forbidden — insufficient permissions",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorContract" },
        },
      },
    };
  }

  responses["500"] = {
    description: "Internal server error",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorContract" },
      },
    },
  };

  return responses;
}

/**
 * Validation / not-found / conflict — appended to specific CRUD
 * operations. Every shape references `ErrorContract`.
 */
export function errorResponse(description: string): Response {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorContract" },
      },
    },
  };
}

/**
 * Create an operation object.
 *
 * @param requiresAuthOverride Override for whether auth is required (used by
 *  custom routes that pass `permissions: allowPublic()` etc., which the
 *  generic `permissions.{operation}` lookup wouldn't find).
 * @param additionalSecurity Extra security alternatives from external
 *  integrations (OR'd with bearerAuth) — e.g. plugin-injected
 *  `apiKeyAuth + orgHeader` combos.
 */
export function createOperation(
  resource: RegistryEntry,
  operation: string,
  summary: string,
  extras: Partial<Operation>,
  requiresAuthOverride?: boolean,
  additionalSecurity: Array<Record<string, string[]>> = [],
): Operation {
  const permissions = resource.permissions || {};
  const operationPermission = (permissions as Record<string, unknown>)[operation];
  const isPublic = (operationPermission as PermissionCheck)?._isPublic === true;
  const _requiredRoles = (operationPermission as PermissionCheck)?._roles;
  const requiresAuth =
    requiresAuthOverride !== undefined
      ? requiresAuthOverride
      : typeof operationPermission === "function" && !isPublic;

  const permAnnotation = describePermissionForOpenApi(operationPermission);

  // Build description with permission + preset info
  const descParts: string[] = [];
  if (permAnnotation) {
    descParts.push(
      `**Permission**: ${
        permAnnotation.type === "public"
          ? "Public"
          : permAnnotation.type === "requireRoles"
            ? `Requires roles: ${(permAnnotation.roles ?? []).join(", ")}`
            : "Requires authentication"
      }`,
    );
  }
  if (resource.presets && resource.presets.length > 0) {
    descParts.push(`**Presets**: ${resource.presets.join(", ")}`);
  }
  // Pipeline steps that apply to this operation
  const applicableSteps = (resource.pipelineSteps ?? []).filter((s) => {
    if (!s.operations) return true;
    return s.operations.includes(operation);
  });

  const op: Operation = {
    tags: [resource.tag || "Resource"],
    summary: `${summary} ${(resource.displayName || resource.name).toLowerCase()}`,
    operationId: `${resource.name}_${operation}`,
    ...(descParts.length > 0 && { description: descParts.join("\n\n") }),
    ...(requiresAuth && {
      security: [{ bearerAuth: [] }, ...additionalSecurity],
    }),
    ...(permAnnotation && { "x-arc-permission": permAnnotation }),
    ...(applicableSteps.length > 0 && {
      "x-arc-pipeline": applicableSteps.map((s) => ({ type: s.type, name: s.name })),
    }),
    responses: buildErrorResponses({
      requiresAuth,
      permRoles: permAnnotation?.roles,
    }),
    ...extras,
  };

  // If extras.responses was provided, the spread above replaced the
  // baseline — re-merge so per-route 200/201/etc additions sit alongside
  // the baseline 401/403/500.
  if (extras.responses) {
    op.responses = {
      ...buildErrorResponses({
        requiresAuth,
        permRoles: permAnnotation?.roles,
      }),
      ...extras.responses,
    };
  }

  return op;
}

/**
 * Describe a permission check function for OpenAPI.
 * Extracts role, org role, and team permission metadata from permission
 * functions.
 */
export function describePermissionForOpenApi(
  check: unknown,
): { type: string; roles?: readonly string[]; orgRoles?: readonly string[] } | undefined {
  if (!check || typeof check !== "function") return undefined;

  const fn = check as PermissionCheck & {
    _orgRoles?: readonly string[];
    _orgPermission?: string;
    _teamPermission?: string;
  };

  if (fn._isPublic === true) return { type: "public" };

  const result: { type: string; roles?: readonly string[]; orgRoles?: readonly string[] } = {
    type: "requireAuth",
  };

  if (Array.isArray(fn._roles) && fn._roles.length > 0) {
    result.type = "requireRoles";
    result.roles = fn._roles as string[];
  }
  if (Array.isArray(fn._orgRoles) && fn._orgRoles.length > 0) {
    result.orgRoles = fn._orgRoles;
  }

  return result;
}
