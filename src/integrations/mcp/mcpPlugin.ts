/**
 * @classytic/arc — MCP Plugin (Level 1)
 *
 * Fastify plugin that auto-generates MCP tools from Arc resources.
 *
 * Two transport modes:
 * - **Stateless** (default) — fresh server per request, no session tracking.
 *   Best for production, horizontal scaling, serverless, edge.
 * - **Stateful** — sessions cached with TTL, reused across requests.
 *   Use when you need server-initiated notifications or long-lived connections.
 *
 * Auth is NOT enforced — the plugin respects whatever auth mode you choose:
 * - `auth: false` — no auth, anonymous access (dev/testing/stdio)
 * - `auth: betterAuthInstance` — OAuth 2.1 via Better Auth's mcp() plugin
 * - `auth: async (headers) => {...}` — custom function (API key, JWT, gateway, etc.)
 *
 * @example
 * ```typescript
 * // Stateless (default) — production, scalable
 * await app.register(mcpPlugin, { resources, auth: false });
 *
 * // Stateful — when you need session persistence
 * await app.register(mcpPlugin, { resources, stateful: true, sessionTtlMs: 600000 });
 *
 * // Multiple MCP endpoints scoped to different resource groups
 * await app.register(mcpPlugin, { resources: catalogResources, prefix: '/mcp/catalog' });
 * await app.register(mcpPlugin, { resources: orderResources, prefix: '/mcp/orders' });
 * ```
 */

import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { isBetterAuth, registerOAuthDiscovery, resolveMcpAuth } from "./authBridge.js";
import { type AuthRef, createMcpServer, type McpServerInstance } from "./createMcpServer.js";
import { resourceToTools } from "./resourceToTools.js";
import { registerSchemaResources } from "./schemaResources.js";
import { McpSessionCache } from "./sessionCache.js";
import type { CrudOperation, McpPluginOptions, SessionEntry } from "./types.js";

// ============================================================================
// Fastify type augmentation
// ============================================================================

declare module "fastify" {
  interface FastifyInstance {
    mcp?: {
      sessions: McpSessionCache | null;
      toolNames: string[];
      resourceNames: string[];
      stateful: boolean;
    };
  }
}

// ============================================================================
// Plugin
// ============================================================================

const mcpPluginImpl: FastifyPluginAsync<McpPluginOptions> = async (fastify, options) => {
  // ── 1. Dynamic import guard ──
  let StreamableHTTPServerTransport: new (
    opts: Record<string, unknown>,
  ) => SessionEntry["transport"] & { sessionId: string };
  try {
    const mod = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    StreamableHTTPServerTransport =
      mod.StreamableHTTPServerTransport as typeof StreamableHTTPServerTransport;
    await import("zod");
  } catch {
    throw new Error(
      "@modelcontextprotocol/sdk and zod are required for MCP support. " +
        "Install them: npm install @modelcontextprotocol/sdk zod",
    );
  }

  // ── 2. Filter resources ──
  const excludeSet = new Set(options.exclude ?? []);
  const enabledResources = options.resources.filter((r) => !excludeSet.has(r.name));

  // ── 3. Generate tool definitions ──
  const overrides = options.overrides ?? {};
  const allTools = enabledResources.flatMap((r) =>
    resourceToTools(r, { ...overrides[r.name], toolNamePrefix: options.toolNamePrefix }),
  );
  if (options.extraTools) allTools.push(...options.extraTools);

  fastify.log.info(`mcpPlugin: ${allTools.length} tools from ${enabledResources.length} resources`);

  // ── 4. Override map for schema resources ──
  const overrideOpsMap: Record<string, { operations?: CrudOperation[] }> = {};
  for (const [name, cfg] of Object.entries(overrides)) {
    overrideOpsMap[name] = { operations: cfg.operations };
  }

  // ── 5. Mode: stateless (default) or stateful ──
  const stateful = options.stateful === true;
  const cache = stateful
    ? new McpSessionCache({ ttlMs: options.sessionTtlMs, maxSessions: options.maxSessions })
    : null;

  // ── 6. Server factory ──
  async function createServerInstance(authRef: AuthRef): Promise<McpServerInstance> {
    const server = await createMcpServer(
      {
        name: options.serverName ?? "arc-mcp",
        version: options.serverVersion ?? "1.0.0",
        instructions: options.instructions,
        tools: allTools,
        prompts: options.extraPrompts,
      },
      authRef,
    );
    registerSchemaResources(server, enabledResources, overrideOpsMap);
    return server;
  }

  // ── 7. OAuth discovery (Better Auth only) ──
  if (options.auth && isBetterAuth(options.auth)) {
    await registerOAuthDiscovery(fastify, options.auth);
  }

  // ── 8. MCP HTTP routes ──
  const prefix = options.prefix ?? "/mcp";

  if (stateful) {
    // ────────────────────────────────────────────────────────────
    // STATEFUL MODE — session-cached, reused across requests
    // ────────────────────────────────────────────────────────────
    registerStatefulRoutes(
      fastify,
      prefix,
      options,
      cache!,
      createServerInstance,
      StreamableHTTPServerTransport,
    );
  } else {
    // ────────────────────────────────────────────────────────────
    // STATELESS MODE — fresh server per request, no session tracking
    // Best for production, horizontal scaling, serverless
    // ────────────────────────────────────────────────────────────
    registerStatelessRoutes(
      fastify,
      prefix,
      options,
      createServerInstance,
      StreamableHTTPServerTransport,
    );
  }

  // ── 9. Graceful shutdown ──
  if (cache) {
    fastify.addHook("onClose", async () => cache.close());
  }

  // ── 10. Decorate ──
  if (!fastify.hasDecorator("mcp")) {
    fastify.decorate("mcp", {
      sessions: cache,
      toolNames: allTools.map((t) => t.name),
      resourceNames: enabledResources.map((r) => r.name),
      stateful,
    });
  }
};

// ============================================================================
// Stateless Routes
// ============================================================================

function registerStatelessRoutes(
  fastify: Parameters<FastifyPluginAsync>[0],
  prefix: string,
  options: McpPluginOptions,
  createServer: (authRef: AuthRef) => Promise<McpServerInstance>,
  Transport: new (
    opts: Record<string, unknown>,
  ) => SessionEntry["transport"] & { sessionId: string },
): void {
  // POST /mcp — each request gets a fresh server + transport
  fastify.post(prefix, async (request, reply) => {
    const authResult = await resolveMcpAuth(
      request.headers as Record<string, string | undefined>,
      options.auth ?? false,
    );
    if (!authResult && options.auth) {
      return reply
        .code(401)
        .send({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized" } });
    }

    const authRef: AuthRef = { current: authResult };
    const transport = new Transport({ sessionIdGenerator: undefined });
    const server = await createServer(authRef);
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // GET /mcp — not supported in stateless mode (no SSE stream without sessions)
  fastify.get(prefix, async (_request, reply) => {
    reply.code(405).send({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "SSE not available in stateless mode. Use stateful: true for server-initiated messages.",
      },
    });
  });

  // DELETE /mcp — no-op in stateless mode
  fastify.delete(prefix, async (_request, reply) => {
    reply.code(200).send();
  });
}

// ============================================================================
// Stateful Routes
// ============================================================================

function registerStatefulRoutes(
  fastify: Parameters<FastifyPluginAsync>[0],
  prefix: string,
  options: McpPluginOptions,
  cache: McpSessionCache,
  createServer: (authRef: AuthRef) => Promise<McpServerInstance>,
  Transport: new (
    opts: Record<string, unknown>,
  ) => SessionEntry["transport"] & { sessionId: string },
): void {
  // POST /mcp — reuse session or create new one
  fastify.post(prefix, async (request, reply) => {
    const authResult = await resolveMcpAuth(
      request.headers as Record<string, string | undefined>,
      options.auth ?? false,
    );
    if (!authResult && options.auth) {
      return reply
        .code(401)
        .send({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized" } });
    }

    const sessionId = request.headers["mcp-session-id"] as string | undefined;

    // Existing session
    if (sessionId) {
      const entry = cache.get(sessionId);
      if (entry) {
        cache.touch(sessionId);
        entry.auth = authResult;
        entry.authRef.current = authResult;
        await entry.transport.handleRequest(request.raw, reply.raw, request.body);
        return;
      }
    }

    // New session
    const authRef: AuthRef = { current: authResult };
    const transport = new Transport({ sessionIdGenerator: undefined });
    const server = await createServer(authRef);
    await server.connect(transport);

    cache.set(transport.sessionId, {
      transport,
      lastAccessed: Date.now(),
      organizationId: authResult?.organizationId ?? "",
      auth: authResult,
      authRef,
    });

    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // GET /mcp — SSE stream for server-initiated messages
  fastify.get(prefix, async (request, reply) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) return reply.code(400).send({ error: "Missing Mcp-Session-Id header" });

    const entry = cache.get(sessionId);
    if (!entry) return reply.code(404).send({ error: "Session not found" });

    cache.touch(sessionId);
    await entry.transport.handleRequest(request.raw, reply.raw);
  });

  // DELETE /mcp — session termination
  fastify.delete(prefix, async (request, reply) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (sessionId) cache.remove(sessionId);
    reply.code(200).send();
  });
}

// ============================================================================
// Export
// ============================================================================

export const mcpPlugin = fp(mcpPluginImpl, {
  name: "arc-mcp",
  fastify: "5.x",
});
