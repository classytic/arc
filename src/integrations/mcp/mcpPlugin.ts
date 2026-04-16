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

import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import {
  isBetterAuth,
  McpAuthCache,
  registerOAuthDiscovery,
  resolveMcpAuth,
} from "./authBridge.js";
import { type AuthRef, createMcpServer, type McpServerInstance } from "./createMcpServer.js";
import { resourceToTools } from "./resourceToTools.js";
import { registerSchemaResources } from "./schemaResources.js";
import { McpSessionCache } from "./sessionCache.js";
import type { CrudOperation, McpAuthResult, McpPluginOptions, SessionEntry } from "./types.js";

// ============================================================================
// Fastify type augmentation
// ============================================================================

/**
 * Per-prefix MCP registration info. A single fastify instance can register
 * mcpPlugin multiple times under different prefixes (e.g. `/mcp/catalog`,
 * `/mcp/orders`). The decorator is a map keyed by prefix so multi-registration
 * setups can inspect any endpoint's tool list, not just the first one.
 */
export interface McpRegistration {
  sessions: McpSessionCache | null;
  toolNames: string[];
  resourceNames: string[];
  stateful: boolean;
}

export interface McpDecorator {
  /** Map of prefix → registration info. Iterate for all endpoints. */
  registrations: Map<string, McpRegistration>;
  /** Shortcut for the first registered prefix (back-compat for single-endpoint apps) */
  readonly sessions: McpSessionCache | null;
  readonly toolNames: string[];
  readonly resourceNames: string[];
  readonly stateful: boolean;
  /** Look up a specific prefix */
  get(prefix: string): McpRegistration | undefined;
}

declare module "fastify" {
  interface FastifyInstance {
    mcp?: McpDecorator;
  }
}

// ============================================================================
// Plugin
// ============================================================================

const mcpPluginImpl: FastifyPluginAsync<McpPluginOptions> = async (fastify, options) => {
  // ── 1. Dynamic import guard ──
  // Emit separate diagnostics for SDK vs zod so install hints are actionable.
  let StreamableHTTPServerTransport: new (
    opts: Record<string, unknown>,
  ) => SessionEntry["transport"] & { sessionId: string | undefined };
  try {
    const mod = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    StreamableHTTPServerTransport =
      mod.StreamableHTTPServerTransport as typeof StreamableHTTPServerTransport;
  } catch {
    throw new Error(
      "@modelcontextprotocol/sdk is required for MCP support. " +
        "Install it: npm install @modelcontextprotocol/sdk",
    );
  }
  try {
    await import("zod");
  } catch {
    throw new Error("zod is required for MCP tool schemas. Install it: npm install zod");
  }

  // ── 2. Filter resources — include takes priority over exclude ──
  let enabledResources: typeof options.resources;
  if (options.include) {
    const includeSet = new Set(options.include);
    enabledResources = options.resources.filter((r) => includeSet.has(r.name));
  } else {
    const excludeSet = new Set(options.exclude ?? []);
    enabledResources = options.resources.filter((r) => !excludeSet.has(r.name));
  }

  // ── 3. Generate tool definitions ──
  const overrides = options.overrides ?? {};
  const allTools = enabledResources.flatMap((r) => {
    const resOverrides = overrides[r.name] ?? {};
    return resourceToTools(r, {
      ...resOverrides,
      toolNamePrefix: resOverrides.toolNamePrefix ?? options.toolNamePrefix,
    });
  });
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

  // ── Health endpoint (both modes) — no MCP protocol needed ──
  fastify.get(`${prefix}/health`, async (_request, reply) => {
    reply.send({
      status: "ok",
      mode: stateful ? "stateful" : "stateless",
      tools: allTools.length,
      resources: enabledResources.length,
      toolNames: allTools.map((t) => t.name),
      sessions: cache?.size ?? null,
    });
  });

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
    const authCache =
      options.auth && options.authCacheTtlMs !== 0
        ? new McpAuthCache({ ttlMs: options.authCacheTtlMs })
        : undefined;
    registerStatelessRoutes(
      fastify,
      prefix,
      options,
      createServerInstance,
      StreamableHTTPServerTransport,
      authCache,
    );
  }

  // ── 9. Graceful shutdown ──
  if (cache) {
    fastify.addHook("onClose", async () => cache.close());
  }

  // ── 10. Decorate ──
  // Build the per-prefix registration. A single fastify instance can register
  // mcpPlugin multiple times (e.g. /mcp/catalog, /mcp/orders) — the decorator
  // exposes all of them via `registrations`, plus legacy top-level getters
  // that point at the first-registered endpoint for backwards compatibility.
  const registration: McpRegistration = {
    sessions: cache,
    toolNames: allTools.map((t) => t.name),
    resourceNames: enabledResources.map((r) => r.name),
    stateful,
  };

  if (!fastify.hasDecorator("mcp")) {
    const registrations = new Map<string, McpRegistration>();
    registrations.set(prefix, registration);
    const decorator: McpDecorator = {
      registrations,
      get(p: string) {
        return registrations.get(p);
      },
      get sessions() {
        return registrations.values().next().value?.sessions ?? null;
      },
      get toolNames() {
        return registrations.values().next().value?.toolNames ?? [];
      },
      get resourceNames() {
        return registrations.values().next().value?.resourceNames ?? [];
      },
      get stateful() {
        return registrations.values().next().value?.stateful ?? false;
      },
    };
    fastify.decorate("mcp", decorator);
  } else {
    // Already decorated — add this prefix to the map.
    const existing = fastify.mcp;
    if (existing) {
      if (existing.registrations.has(prefix)) {
        throw new Error(`mcpPlugin: prefix "${prefix}" is already registered`);
      }
      existing.registrations.set(prefix, registration);
    }
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
  ) => SessionEntry["transport"] & { sessionId: string | undefined },
  authCache?: McpAuthCache,
): void {
  // POST /mcp — each request gets a fresh server + transport
  fastify.post(prefix, async (request, reply) => {
    const authResult = await resolveMcpAuth(
      request.headers as Record<string, string | undefined>,
      options.auth ?? false,
      authCache,
    );
    if (!authResult && options.auth) {
      fastify.log.warn({ msg: "mcpPlugin: auth failed", status: 401 });
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
  ) => SessionEntry["transport"] & { sessionId: string | undefined },
): void {
  /** Check if the requesting principal owns the session */
  function isSessionOwner(entry: SessionEntry, authResult: McpAuthResult | null): boolean {
    if (!options.auth || !entry.auth || !authResult) return true;
    const prev = entry.auth;
    // Compare all identity fields — prevents session confusion between
    // different service clients in the same org, and between human/machine principals.
    return (
      prev.userId === authResult.userId &&
      prev.organizationId === authResult.organizationId &&
      prev.clientId === authResult.clientId
    );
  }

  // POST /mcp — reuse session or create new one
  fastify.post(prefix, async (request, reply) => {
    const authResult = await resolveMcpAuth(
      request.headers as Record<string, string | undefined>,
      options.auth ?? false,
    );
    if (!authResult && options.auth) {
      fastify.log.warn({ msg: "mcpPlugin: auth failed", status: 401 });
      return reply
        .code(401)
        .send({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized" } });
    }

    const sessionId = request.headers["mcp-session-id"] as string | undefined;

    // Existing session — verify ownership before reuse
    if (sessionId) {
      const entry = cache.get(sessionId);
      if (entry) {
        // Reject if the session belongs to a different user/org (prevents session fixation)
        if (!isSessionOwner(entry, authResult)) {
          return reply.code(403).send({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Session ownership mismatch" },
          });
        }
        cache.touch(sessionId);
        entry.auth = authResult;
        entry.authRef.current = authResult;
        await entry.transport.handleRequest(request.raw, reply.raw, request.body);
        return;
      }
    }

    // New session — stateful mode NEEDS a sessionIdGenerator. Passing
    // `undefined` (as stateless mode does) disables the SDK's session
    // management entirely, leaving `transport.sessionId` undefined and
    // breaking cache.set() / session reuse.
    //
    // The `onsessioninitialized` callback fires when the SDK assigns the
    // session id during the initialize handshake — this is the only
    // reliable moment to wire the entry into the cache, since
    // `transport.sessionId` is undefined until then.
    const authRef: AuthRef = { current: authResult };
    const transport: SessionEntry["transport"] & { sessionId: string | undefined } = new Transport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId: string) => {
        cache.set(newSessionId, {
          transport,
          lastAccessed: Date.now(),
          organizationId: authResult?.organizationId ?? "",
          auth: authResult,
          authRef,
        });
      },
    });
    const server = await createServer(authRef);
    await server.connect(transport);

    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // GET /mcp — SSE stream for server-initiated messages
  fastify.get(prefix, async (request, reply) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) return reply.code(400).send({ error: "Missing Mcp-Session-Id header" });

    const entry = cache.get(sessionId);
    // Return 403 (not 404) to prevent session enumeration
    if (!entry) return reply.code(403).send({ error: "Unauthorized" });

    // Re-verify auth — prevent session hijacking via stolen session ID.
    // Also refresh `entry.auth` + `entry.authRef.current` so server-initiated
    // messages from tool handlers see the latest identity (e.g. if the
    // caller's roles changed between POST and GET).
    if (options.auth) {
      const authResult = await resolveMcpAuth(
        request.headers as Record<string, string | undefined>,
        options.auth,
      );
      if (!isSessionOwner(entry, authResult)) {
        return reply.code(403).send({ error: "Unauthorized" });
      }
      entry.auth = authResult;
      entry.authRef.current = authResult;
    }

    cache.touch(sessionId);
    await entry.transport.handleRequest(request.raw, reply.raw);
  });

  // DELETE /mcp — session termination (requires ownership proof)
  fastify.delete(prefix, async (request, reply) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) return reply.code(400).send({ error: "Missing Mcp-Session-Id header" });

    const entry = cache.get(sessionId);
    if (!entry) return reply.code(204).send();

    // Verify the requester owns the session before termination.
    // Refresh auth snapshot to keep parity with POST/GET semantics.
    if (options.auth) {
      const authResult = await resolveMcpAuth(
        request.headers as Record<string, string | undefined>,
        options.auth,
      );
      if (!isSessionOwner(entry, authResult)) {
        return reply.code(403).send({ error: "Unauthorized" });
      }
      entry.auth = authResult;
      entry.authRef.current = authResult;
    }

    cache.remove(sessionId);
    reply.code(204).send();
  });
}

// ============================================================================
// Export
// ============================================================================

export const mcpPlugin = fp(mcpPluginImpl, {
  name: "arc-mcp",
  fastify: "5.x",
});
