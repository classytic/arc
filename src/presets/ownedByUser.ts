/**
 * Owned By User Preset
 *
 * Adds ownership validation for update/delete operations.
 *
 * BEHAVIOR (fail-closed):
 * - On update/delete, installs `_ownershipCheck` on the request; the
 *   controller enforces `ownerField === userId` before mutating.
 * - No authenticated identity (or a user without an id) is DENIED here.
 * - A record missing the owner value is DENIED by default; pass
 *   `missingOwner: 'allow'` for an explicit legacy/compat escape hatch.
 *
 * BYPASS:
 * - ELEVATED scope only (platform admin) skips the ownership check. This
 *   preset deliberately does NOT take a `bypassRoles` option — platform-role
 *   shortcuts don't belong in tenant ownership policy. If you need a role to
 *   bypass ownership, model it as a permission: `anyOf(requireRoles([...]),
 *   requireOwnership(ownerField, { bypassRoles: [...] }))`.
 *
 * @example
 * defineResource({
 *   name: 'post',
 *   presets: [{ name: 'ownedByUser', ownerField: 'authorId' }],
 * });
 *
 * // User A cannot update/delete User B's posts
 * // A platform admin (elevated scope) can modify any post
 */

import type { FastifyReply } from "fastify";
import { requireAuth } from "../permissions/core.js";
import { isElevated, PUBLIC_SCOPE } from "../scope/types.js";
import type {
  MiddlewareConfig,
  PresetResult,
  RequestWithExtras,
  RouteHandler,
} from "../types/index.js";
import { UnauthorizedError } from "../utils/errors.js";

export interface OwnedByUserOptions {
  ownerField?: string;
  /**
   * What to do when a target record has NO value in `ownerField` (legacy /
   * unowned records).
   *
   * - `"deny"` (default): fail closed — an unowned record is NOT modifiable
   *   through an ownership-gated route. This is the secure default; ownership
   *   that silently passes for records missing the owner is not an ownership
   *   primitive.
   * - `"allow"`: legacy compatibility — permit modifying records that predate
   *   the owner field. Visibly unsafe; opt in only for a bounded migration.
   */
  missingOwner?: "deny" | "allow";
}

/**
 * Create ownership check middleware.
 *
 * FAIL-CLOSED: ownership is meaningless without an authenticated identity, so a
 * request with no user (or a user with no id) is DENIED here rather than sliding
 * through with no ownership check installed. Elevated scope (platform admin)
 * bypasses the check by design.
 */
function createOwnershipCheck(ownerField: string, missingOwner: "deny" | "allow"): RouteHandler {
  return async (request: RequestWithExtras, _reply: FastifyReply): Promise<void> => {
    // Elevated scope (platform admin) bypasses ownership check.
    const scope = request.scope ?? PUBLIC_SCOPE;
    if (isElevated(scope)) return;

    const user = request.user;
    // Fail closed: no identity → cannot own anything → deny.
    if (!user) {
      throw new UnauthorizedError("Authentication required for this operation");
    }
    const userWithId = user as { _id?: string; id?: string };
    const userId = userWithId._id ?? userWithId.id;
    if (!userId) {
      throw new UnauthorizedError("Authenticated identity has no usable id");
    }

    // Install the ownership check for the controller to enforce against the record.
    request._ownershipCheck = {
      field: ownerField,
      userId,
      missingOwner,
    };
  };
}

export function ownedByUserPreset(options: OwnedByUserOptions = {}): PresetResult {
  const { ownerField = "userId", missingOwner = "deny" } = options;

  const ownershipMiddleware = createOwnershipCheck(ownerField, missingOwner);

  return {
    name: "ownedByUser",
    // Authorization lives in the permission model, not just middleware. Inject
    // `requireAuth()` as a SECURE DEFAULT on the mutating ops so an ownership
    // resource REQUIRES authentication at `onRequest` (never public-by-omission,
    // never dependent on optional-auth), and the gate is visible to
    // introspection + MCP. A host that declares its own update/delete permission
    // overrides this (merge is host-wins). The middleware still enforces the
    // per-record owner match (and the elevated-scope bypass) on top.
    permissions: {
      update: requireAuth(),
      delete: requireAuth(),
    },
    middlewares: {
      update: [ownershipMiddleware],
      delete: [ownershipMiddleware],
    } as MiddlewareConfig,
  };
}
