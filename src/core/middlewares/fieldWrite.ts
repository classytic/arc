/**
 * Field-write permission enforcement for custom routes.
 */

import type { RouteHandlerMethod } from "fastify";

import {
  applyFieldWritePermissions,
  type FieldPermissionMap,
  resolveEffectiveRoles,
} from "../../permissions/fields.js";
import { getUserRoles } from "../../permissions/types.js";
import { isElevated, isMember, PUBLIC_SCOPE, type RequestScope } from "../../scope/types.js";
import { ForbiddenError } from "../../utils/errors.js";
import type { FieldWriteDenialPolicy } from "../BodySanitizer.js";
import { DEFAULT_FIELD_WRITE_DENIAL_POLICY } from "../BodySanitizer.js";

/**
 * Build a preHandler that enforces field-write permissions on the request body.
 *
 * Auto-CRUD's create/update routes get this for free via `BodySanitizer.sanitize()`
 * inside `BaseController`. Custom routes (`config.routes`, presets, action endpoints)
 * never went through that path — so a host that declared
 * `fields: { role: fields.writableBy(['admin']) }` and a custom
 * `POST /users/promote` happily accepted `{ role: 'admin' }` from any caller.
 *
 * This preHandler closes that gap. It applies ONLY the `applyFieldWritePermissions`
 * step — no `SYSTEM_FIELDS` strip, no `fieldRules` strip — because custom-route
 * bodies don't necessarily mirror the resource's adapter shape, and we'd
 * generate surprising 403s by enforcing rules tied to that shape.
 *
 * Returns `null` when the resource has no field permissions configured — the
 * caller should then skip wiring it into the preHandler chain.
 */
export function buildFieldWritePreHandler(
  fieldPermissions: FieldPermissionMap | undefined,
  policy: FieldWriteDenialPolicy = DEFAULT_FIELD_WRITE_DENIAL_POLICY,
): RouteHandlerMethod | null {
  if (!fieldPermissions || Object.keys(fieldPermissions).length === 0) return null;

  return async (request, _reply) => {
    const body = (request as { body?: unknown }).body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return;

    const scope = (request as { scope?: RequestScope }).scope ?? PUBLIC_SCOPE;
    // Elevated scope (platform admin) bypasses field restrictions — consistent
    // with `BodySanitizer.sanitize` and `requireOrgRole()`.
    if (isElevated(scope)) return;

    const globalRoles = getUserRoles((request as { user?: Record<string, unknown> }).user);
    const orgRoles = isMember(scope) ? scope.orgRoles : [];
    const effectiveRoles = resolveEffectiveRoles(globalRoles, orgRoles);

    const { body: filtered, deniedFields } = applyFieldWritePermissions(
      body as Record<string, unknown>,
      fieldPermissions,
      effectiveRoles,
    );

    if (deniedFields.length > 0 && policy === "reject") {
      throw new ForbiddenError(
        `Not permitted to write field${deniedFields.length === 1 ? "" : "s"}: ${deniedFields.join(", ")}`,
      );
    }

    (request as { body: unknown }).body = filtered;
  };
}

/**
 * True for HTTP methods that carry a request body and should run the
 * field-write preHandler. GET/DELETE/HEAD/OPTIONS skip enforcement.
 */
export function methodCarriesBody(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH";
}
