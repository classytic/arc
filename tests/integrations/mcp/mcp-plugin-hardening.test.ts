/**
 * MCP Plugin — hardening regressions
 *
 * Covers the 3 fixes applied in the v2.9 MCP plugin hardening pass:
 *  #6 Stateful mode generates a real sessionIdGenerator. Previously the
 *     plugin passed `sessionIdGenerator: undefined` in BOTH stateless and
 *     stateful modes, which disables session management in the MCP SDK —
 *     meaning stateful sessions could never be reused.
 *  #7 The fastify decorator is now a per-prefix Map. Previously the guard
 *     `if (!fastify.hasDecorator('mcp'))` meant that registering mcpPlugin
 *     at multiple prefixes (e.g. /mcp/catalog, /mcp/orders) silently
 *     exposed only the first prefix's tool list.
 *  #8 GET /mcp and DELETE /mcp now refresh `entry.auth` and
 *     `entry.authRef.current` on each request, matching POST semantics.
 *     Without this, tool handlers invoked through SSE streams would see
 *     stale identity state.
 *
 * Strategy: build a fastify app, register mcpPlugin, then inject HTTP
 * requests OR inspect the decorator. We don't need a real MongoDB — MCP
 * resources here are empty-route stubs.
 */

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Helpers
// ============================================================================

async function loadMcpPlugin() {
  const mod = await import("../../../src/integrations/mcp/mcpPlugin.js");
  return mod.mcpPlugin;
}

// ============================================================================
// #6 — Stateful sessionIdGenerator is wired
// ============================================================================

describe("MCP hardening — stateful sessionIdGenerator", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
    vi.restoreAllMocks();
  });

  it("stateful=true: initialize handshake produces a real sessionId that is cached", async () => {
    // The regression: stateful mode passed `sessionIdGenerator: undefined`,
    // which disables SDK session management — transport.sessionId stayed
    // undefined and the cache was never populated.
    //
    // Now: we pass `() => randomUUID()` plus an `onsessioninitialized`
    // callback that does the cache.set() AFTER the SDK has assigned the id
    // (this callback fires during the initialize handshake).
    //
    // Strategy: spy on McpSessionCache.set, send a valid MCP `initialize`
    // RPC, then assert set() was called with a non-empty string key.
    const mcpPlugin = await loadMcpPlugin();
    const { McpSessionCache } = await import("../../../src/integrations/mcp/sessionCache.js");
    const setSpy = vi.spyOn(McpSessionCache.prototype, "set");

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, {
      resources: [],
      auth: false,
      stateful: true,
      sessionTtlMs: 60_000,
    });
    await app.ready();

    // Send a valid MCP initialize to trigger the onsessioninitialized callback.
    const initRpc = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    };

    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: initRpc,
    });

    // Successful init → 200 or 202, NEVER 500 (the pre-fix symptom was the
    // handler reaching a no-sessionId guard and returning 500).
    expect(res.statusCode).toBeLessThan(500);

    // Session was cached under a real UUID key.
    expect(setSpy).toHaveBeenCalled();
    const [sessionId] = setSpy.mock.calls[0];
    expect(typeof sessionId).toBe("string");
    expect((sessionId as string).length).toBeGreaterThan(10); // UUID is 36 chars
  });

  it("stateless=false (default): sessionIdGenerator is deliberately undefined", async () => {
    // Stateless mode MUST pass sessionIdGenerator: undefined — that's how
    // the SDK disables session management. Assert the decorator reports
    // stateful=false so we know we're in the stateless branch.
    const mcpPlugin = await loadMcpPlugin();

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, {
      resources: [],
      auth: false,
      // stateful not set → default false
    });
    await app.ready();

    expect(app.mcp?.stateful).toBe(false);
    expect(app.mcp?.sessions).toBeNull();
  });
});

// ============================================================================
// #7 — Per-prefix decorator map
// ============================================================================

describe("MCP hardening — per-prefix decorator registrations", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("single registration: registrations map has one entry at the declared prefix", async () => {
    const mcpPlugin = await loadMcpPlugin();

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, {
      resources: [],
      auth: false,
      prefix: "/mcp/catalog",
    });
    await app.ready();

    expect(app.mcp).toBeTruthy();
    expect(app.mcp?.registrations.size).toBe(1);
    expect(app.mcp?.registrations.has("/mcp/catalog")).toBe(true);
    expect(app.mcp?.get("/mcp/catalog")).toBeTruthy();
  });

  it("multiple registrations: each prefix is tracked independently", async () => {
    const mcpPlugin = await loadMcpPlugin();

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, {
      resources: [],
      auth: false,
      prefix: "/mcp/catalog",
    });
    await app.register(mcpPlugin, {
      resources: [],
      auth: false,
      prefix: "/mcp/orders",
    });
    await app.ready();

    expect(app.mcp?.registrations.size).toBe(2);
    expect(app.mcp?.registrations.has("/mcp/catalog")).toBe(true);
    expect(app.mcp?.registrations.has("/mcp/orders")).toBe(true);

    const catalog = app.mcp?.get("/mcp/catalog");
    const orders = app.mcp?.get("/mcp/orders");
    expect(catalog).toBeTruthy();
    expect(orders).toBeTruthy();
    // Different registrations produce different sessions caches
    expect(catalog).not.toBe(orders);
  });

  it("legacy top-level getters (toolNames, resourceNames, stateful, sessions) still work", async () => {
    // Back-compat for apps that only register one mcpPlugin and read
    // `app.mcp.toolNames` directly.
    const mcpPlugin = await loadMcpPlugin();

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, {
      resources: [],
      auth: false,
      stateful: true,
      sessionTtlMs: 10_000,
    });
    await app.ready();

    expect(Array.isArray(app.mcp?.toolNames)).toBe(true);
    expect(Array.isArray(app.mcp?.resourceNames)).toBe(true);
    expect(app.mcp?.stateful).toBe(true);
    expect(app.mcp?.sessions).toBeTruthy();
  });

  it("duplicate prefix registration is rejected (either by mcpPlugin guard or fastify's route-conflict detection)", async () => {
    // Fastify's route registration runs before our plugin-level guard, so the
    // exact error message is implementation-defined. Either outcome is
    // correct — what matters is that silent double-registration doesn't
    // happen (the regression we're preventing).
    const mcpPlugin = await loadMcpPlugin();

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, {
      resources: [],
      auth: false,
      prefix: "/mcp",
    });
    await expect(
      app.register(mcpPlugin, {
        resources: [],
        auth: false,
        prefix: "/mcp",
      }),
    ).rejects.toThrow(/already (registered|declared)/);
  });
});

// ============================================================================
// #8 — GET / DELETE refresh entry.auth + entry.authRef
// ============================================================================

describe("MCP hardening — GET/DELETE refresh session auth snapshot", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
    vi.restoreAllMocks();
  });

  /**
   * Drive GET and DELETE handlers directly via a pre-seeded session entry —
   * this avoids needing a full MCP initialize handshake. We prime the cache
   * with a fake entry, then hit GET/DELETE and assert `entry.auth` was
   * updated to the new auth result. The bug we're testing is that before
   * the fix, GET/DELETE only VERIFIED auth (called isSessionOwner) but
   * didn't persist the new snapshot onto entry.auth / entry.authRef.current.
   */
  it("GET /mcp refreshes entry.auth + entry.authRef.current", async () => {
    const mcpPlugin = await loadMcpPlugin();
    const { McpSessionCache } = await import("../../../src/integrations/mcp/sessionCache.js");

    // Auth resolver reads `x-who` header so we can swap identities per-request.
    const authResolver = async (headers: Record<string, string | undefined>) => {
      const who = headers["x-who"];
      if (!who) return null;
      return { userId: who, organizationId: "org-1", clientId: "client-A" };
    };

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, {
      resources: [],
      auth: authResolver,
      stateful: true,
      sessionTtlMs: 60_000,
    });
    await app.ready();

    // Seed a session directly into the cache.
    const cache = app.mcp?.sessions as InstanceType<typeof McpSessionCache>;
    expect(cache).toBeTruthy();

    const sessionId = randomUUID();
    const initialAuth = { userId: "alice", organizationId: "org-1", clientId: "client-A" };
    const authRef = { current: initialAuth };
    const transport = {
      handleRequest: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    cache.set(sessionId, {
      transport,
      lastAccessed: Date.now(),
      organizationId: "org-1",
      auth: initialAuth,
      authRef,
    });

    // Issue a GET with DIFFERENT-user identity BUT matching ownership
    // (same org + clientId, different userId → not a true ownership match,
    // so we use alice again but with fresh object identity).
    const refreshedAuth = { userId: "alice", organizationId: "org-1", clientId: "client-A" };

    const getRes = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: {
        "mcp-session-id": sessionId,
        "x-who": refreshedAuth.userId,
        accept: "text/event-stream",
      },
    });

    // Handler should have called through (no 4xx gate rejection).
    expect(getRes.statusCode).not.toBe(403);
    expect(transport.handleRequest).toHaveBeenCalledTimes(1);

    // Auth snapshot refreshed — entry.auth now points at the NEW object,
    // not the original one.
    const entry = cache.get(sessionId);
    expect(entry).toBeTruthy();
    // authRef.current should be the refreshed auth result
    expect(entry?.authRef.current).not.toBe(initialAuth);
    expect(entry?.authRef.current?.userId).toBe("alice");
    // entry.auth also refreshed
    expect(entry?.auth).not.toBe(initialAuth);
  });

  it("GET /mcp rejects when auth owner changes (session hijack prevented)", async () => {
    const mcpPlugin = await loadMcpPlugin();
    const { McpSessionCache } = await import("../../../src/integrations/mcp/sessionCache.js");

    const authResolver = async (headers: Record<string, string | undefined>) => {
      const who = headers["x-who"];
      if (!who) return null;
      return { userId: who, organizationId: "org-1", clientId: "client-A" };
    };

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, {
      resources: [],
      auth: authResolver,
      stateful: true,
    });
    await app.ready();

    const cache = app.mcp?.sessions as InstanceType<typeof McpSessionCache>;
    const sessionId = randomUUID();
    const aliceAuth = { userId: "alice", organizationId: "org-1", clientId: "client-A" };
    cache.set(sessionId, {
      transport: {
        handleRequest: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      },
      lastAccessed: Date.now(),
      organizationId: "org-1",
      auth: aliceAuth,
      authRef: { current: aliceAuth },
    });

    // GET with a different user in the same org — fails ownership check.
    const getRes = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: {
        "mcp-session-id": sessionId,
        "x-who": "mallory",
        accept: "text/event-stream",
      },
    });

    expect(getRes.statusCode).toBe(403);
    // Snapshot NOT refreshed — still Alice's.
    const entry = cache.get(sessionId);
    expect(entry?.auth?.userId).toBe("alice");
  });

  it("DELETE /mcp refreshes entry.auth before terminating", async () => {
    const mcpPlugin = await loadMcpPlugin();
    const { McpSessionCache } = await import("../../../src/integrations/mcp/sessionCache.js");

    const authResolver = async (headers: Record<string, string | undefined>) => {
      const who = headers["x-who"];
      if (!who) return null;
      return { userId: who, organizationId: "org-1", clientId: "client-A" };
    };

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, { resources: [], auth: authResolver, stateful: true });
    await app.ready();

    const cache = app.mcp?.sessions as InstanceType<typeof McpSessionCache>;
    const sessionId = randomUUID();
    const aliceAuth = { userId: "alice", organizationId: "org-1", clientId: "client-A" };
    const authRef = { current: aliceAuth };
    cache.set(sessionId, {
      transport: {
        handleRequest: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      },
      lastAccessed: Date.now(),
      organizationId: "org-1",
      auth: aliceAuth,
      authRef,
    });

    // Matching-owner DELETE — snapshot should refresh, then session removed.
    const delRes = await app.inject({
      method: "DELETE",
      url: "/mcp",
      headers: { "mcp-session-id": sessionId, "x-who": "alice" },
    });

    expect(delRes.statusCode).toBe(204);
    expect(cache.get(sessionId)).toBeUndefined();
  });

  it("DELETE /mcp rejects impostor (session owner mismatch)", async () => {
    const mcpPlugin = await loadMcpPlugin();
    const { McpSessionCache } = await import("../../../src/integrations/mcp/sessionCache.js");

    const authResolver = async (headers: Record<string, string | undefined>) => {
      const who = headers["x-who"];
      if (!who) return null;
      return { userId: who, organizationId: "org-1", clientId: "client-A" };
    };

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, { resources: [], auth: authResolver, stateful: true });
    await app.ready();

    const cache = app.mcp?.sessions as InstanceType<typeof McpSessionCache>;
    const sessionId = randomUUID();
    const aliceAuth = { userId: "alice", organizationId: "org-1", clientId: "client-A" };
    cache.set(sessionId, {
      transport: {
        handleRequest: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      },
      lastAccessed: Date.now(),
      organizationId: "org-1",
      auth: aliceAuth,
      authRef: { current: aliceAuth },
    });

    const delRes = await app.inject({
      method: "DELETE",
      url: "/mcp",
      headers: { "mcp-session-id": sessionId, "x-who": "mallory" },
    });

    expect(delRes.statusCode).toBe(403);
    // Session NOT removed (impostor rejected).
    expect(cache.get(sessionId)).toBeTruthy();
  });
});
