/**
 * Owned By User Preset
 *
 * Adds ownership validation for update/delete operations.
 *
 * BEHAVIOR:
 * - On update/remove, sets _ownershipCheck on request
 * - BaseController enforces ownership before mutation
 * - Users can only modify resources where ownerField matches their ID
 *
 * BYPASS:
 * - Users with bypassRoles (default: ['admin', 'superadmin']) skip check
 * - Resources without the ownerField are not checked
 *
 * @example
 * defineResource({
 *   name: 'post',
 *   presets: [{ name: 'ownedByUser', ownerField: 'authorId' }],
 * });
 *
 * // User A cannot update/delete User B's posts
 * // Admins can modify any post
 */

import type { FastifyReply } from "fastify";
import { isElevated, PUBLIC_SCOPE } from "../scope/types.js";
import type {
  MiddlewareConfig,
  PresetResult,
  RequestWithExtras,
  RouteHandler,
} from "../types/index.js";

export interface OwnedByUserOptions {
  ownerField?: string;
}

/**
 * Create ownership check middleware.
 * Elevated scope (platform admin) bypasses ownership checks.
 */
function createOwnershipCheck(ownerField: string): RouteHandler {
  return async (request: RequestWithExtras, _reply: FastifyReply): Promise<void> => {
    const user = request.user;
    if (!user) return;

    // Elevated scope bypasses ownership check
    const scope = request.scope ?? PUBLIC_SCOPE;
    if (isElevated(scope)) return;

    // Set ownership check for controller to validate
    const userWithId = user as { _id?: string; id?: string };
    const userId = userWithId._id ?? userWithId.id;
    if (userId) {
      request._ownershipCheck = {
        field: ownerField,
        userId,
      };
    }
  };
}

export function ownedByUserPreset(options: OwnedByUserOptions = {}): PresetResult {
  const { ownerField = "userId" } = options;

  const ownershipMiddleware = createOwnershipCheck(ownerField);

  return {
    name: "ownedByUser",
    middlewares: {
      update: [ownershipMiddleware],
      delete: [ownershipMiddleware],
    } as MiddlewareConfig,
  };
}

export default ownedByUserPreset;
