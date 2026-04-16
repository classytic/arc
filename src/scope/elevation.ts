/**
 * Elevation Plugin — Explicit Platform Admin Access
 *
 * Opt-in Fastify plugin that allows platform admins to explicitly
 * elevate their scope via the `x-arc-scope: platform` header.
 *
 * Without this header, a superadmin is treated as a normal user.
 * This prevents implicit bypass and enables audit logging.
 *
 * ## Lifecycle
 *
 * Elevation wraps `fastify.authenticate` so it always runs AFTER
 * authentication has set `request.user`. This avoids the `onRequest`
 * timing issue where `request.user` doesn't exist yet.
 *
 * Flow: `authenticate()` → user is set → `elevation check` → scope is set
 *
 * Inspired by Stripe Connect's `Stripe-Account` header.
 *
 * @example
 * ```typescript
 * const app = await createApp({
 *   auth: { type: 'betterAuth', betterAuth: adapter },
 *   elevation: {
 *     platformRoles: ['superadmin'],
 *     onElevation: (event) => auditLog.write(event),
 *   },
 * });
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { arcLog } from "../logger/index.js";
import { getUserRoles } from "../permissions/types.js";
import type { RequestScope } from "./types.js";

const log = arcLog("elevation");

// ============================================================================
// Types
// ============================================================================

export interface ElevationOptions {
  /** Roles that can use elevation (default: ['superadmin']) */
  platformRoles?: string[];
  /** Header name for scope declaration (default: 'x-arc-scope') */
  scopeHeader?: string;
  /** Header name for target organization (default: 'x-organization-id') */
  orgHeader?: string;
  /** Called when elevation happens — use for audit logging */
  onElevation?: (event: ElevationEvent) => void | Promise<void>;
}

export interface ElevationEvent {
  userId: string;
  organizationId?: string;
  request: FastifyRequest;
  timestamp: Date;
}

// ============================================================================
// Plugin
// ============================================================================

const elevationPlugin: FastifyPluginAsync<ElevationOptions> = async (
  fastify: FastifyInstance,
  opts: ElevationOptions = {},
) => {
  const {
    platformRoles = ["superadmin"],
    scopeHeader = "x-arc-scope",
    orgHeader = "x-organization-id",
    onElevation,
  } = opts;

  // Elevation requires auth — wrap the authenticate decorator
  if (!fastify.hasDecorator("authenticate")) {
    log.warn(
      "authenticate decorator not found. " +
        "Register auth before elevation. Elevation will not function.",
    );
    return;
  }

  const originalAuthenticate = fastify.authenticate;

  // Replace authenticate with elevation-aware version
  const authenticateWithElevation = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    // Step 1: Run original auth (sets request.user + default scope)
    await originalAuthenticate.call(fastify, request, reply);

    // If auth failed and sent a reply, stop
    if (reply.sent) return;

    // Step 2: Check elevation header
    const headerValue = request.headers[scopeHeader] as string | undefined;
    if (headerValue !== "platform") return;

    // Step 3: Validate user for elevation
    const user = request.user;
    if (!user) {
      log.debug("Elevation requested but no user after auth");
      reply.code(401).send({
        success: false,
        error: "Unauthorized",
        message: "Authentication required for platform elevation",
        code: "ELEVATION_AUTH_REQUIRED",
      });
      return;
    }

    const userRoles = getUserRoles(user);
    if (!platformRoles.some((r) => userRoles.includes(r))) {
      log.debug("Elevation rejected — insufficient roles", {
        userId: user.id ?? user._id,
        userRoles,
        required: platformRoles,
      });
      reply.code(403).send({
        success: false,
        error: "Forbidden",
        message: "Insufficient privileges for platform elevation",
        code: "ELEVATION_FORBIDDEN",
      });
      return;
    }

    // Step 4: Build elevated scope
    const orgId = request.headers[orgHeader] as string | undefined;
    const userId = String(user.id ?? user._id ?? "unknown");

    const scope: RequestScope = {
      kind: "elevated",
      userId,
      organizationId: orgId || undefined,
      elevatedBy: userId,
    };

    request.scope = scope;
    log.debug("Scope elevated", { userId, organizationId: orgId });

    // Step 5: Emit audit event — always. Apps that register onElevation get
    // a direct callback; apps that don't still see the event via `arc.events`
    // so privilege elevation is never silently lost. The WAL skips arc.*
    // events so this does not impact startup for durable stores.
    const event = {
      userId,
      organizationId: orgId || undefined,
      request,
      timestamp: new Date(),
    };

    const publish = (
      fastify as unknown as { events?: { publish?: (t: string, p: unknown) => Promise<void> } }
    ).events?.publish;
    if (publish) {
      try {
        await publish("arc.scope.elevated", {
          userId: event.userId,
          organizationId: event.organizationId,
          route: request.routeOptions?.url ?? request.url,
          method: request.method,
          requestId: request.id,
          timestamp: event.timestamp.toISOString(),
        });
      } catch (err) {
        log.warn("Failed to publish arc.scope.elevated event", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (onElevation) {
      try {
        await onElevation(event);
      } catch {
        log.warn("onElevation callback threw — continuing request");
      }
    }
  };

  // Overwrite the authenticate decorator
  fastify.authenticate = authenticateWithElevation;

  log.debug("Plugin registered", { platformRoles, scopeHeader });
};

export default fp(elevationPlugin, {
  name: "arc-elevation",
  fastify: "5.x",
});

export { elevationPlugin };
