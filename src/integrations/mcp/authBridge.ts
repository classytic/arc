/**
 * @classytic/arc — MCP Auth Bridge
 *
 * Resolves MCP session identity from request headers.
 * Supports three modes — the user chooses:
 *
 * 1. `false` — no auth, anonymous access
 * 2. `BetterAuthHandler` — OAuth 2.1 via Better Auth
 * 3. `McpAuthResolver` — custom function (API key, JWT, gateway headers, etc.)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BetterAuthHandler, McpAuthResolver, McpAuthResult } from "./types.js";

// ============================================================================
// Type guard
// ============================================================================

/** Distinguish BetterAuthHandler from McpAuthResolver */
function isBetterAuth(auth: BetterAuthHandler | McpAuthResolver): auth is BetterAuthHandler {
  return typeof auth === "object" && auth !== null && "api" in auth && "handler" in auth;
}

// ============================================================================
// Auth Resolution
// ============================================================================

/**
 * Resolve MCP session identity from request headers.
 *
 * @param headers - HTTP request headers
 * @param auth - false | BetterAuthHandler | McpAuthResolver
 */
export async function resolveMcpAuth(
  headers: Record<string, string | undefined>,
  auth: BetterAuthHandler | McpAuthResolver | false,
): Promise<McpAuthResult | null> {
  // No-auth mode
  if (auth === false) {
    return { userId: "anonymous" };
  }

  // Custom resolver function
  if (typeof auth === "function") {
    try {
      return await auth(headers);
    } catch {
      return null;
    }
  }

  // Better Auth mode
  if (isBetterAuth(auth)) {
    try {
      const session = await auth.api.getMcpSession({ headers });
      if (!session?.userId) return null;
      return {
        userId: session.userId,
        organizationId: session.activeOrganizationId,
      };
    } catch {
      return null;
    }
  }

  return null;
}

// ============================================================================
// OAuth Discovery Endpoints (Better Auth only)
// ============================================================================

/**
 * Register OAuth 2.1 discovery endpoints for MCP clients.
 * Only relevant when using Better Auth — custom auth doesn't need these.
 */
export async function registerOAuthDiscovery(
  fastify: FastifyInstance,
  auth: BetterAuthHandler,
): Promise<void> {
  // OAuth Authorization Server Metadata (RFC 8414)
  fastify.get("/.well-known/oauth-authorization-server", async (req, reply) => {
    const response = await auth.handler(toWebRequest(req));
    await forwardResponse(reply, response);
  });

  // OAuth Protected Resource Metadata (RFC 9728)
  fastify.get("/.well-known/oauth-protected-resource", async (req, reply) => {
    const response = await auth.handler(toWebRequest(req));
    await forwardResponse(reply, response);
  });
}

/**
 * Check if auth option is a BetterAuthHandler (needs discovery endpoints).
 */
export { isBetterAuth };

// ============================================================================
// Helpers
// ============================================================================

function toWebRequest(req: FastifyRequest): Request {
  const protocol = req.protocol ?? "http";
  const host = req.hostname ?? "localhost";
  return new Request(`${protocol}://${host}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  });
}

async function forwardResponse(reply: FastifyReply, response: Response): Promise<void> {
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "transfer-encoding") reply.header(key, value);
  });
  reply.send(await response.text());
}
