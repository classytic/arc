/**
 * MCP Plugin — hardening regressions
 *
 *  - The removed session mode (`stateful: true`) fails the boot instead of
 *    being silently ignored.
 *  - The fastify decorator is a per-prefix Map, so registering mcpPlugin at
 *    several prefixes exposes every prefix's tool list, not just the first.
 *  - DNS-rebinding protection (Host / Origin) on the MCP routes.
 *
 * Strategy: build a fastify app, register mcpPlugin, then inject HTTP
 * requests OR inspect the decorator.
 */

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
// Removed session options
// ============================================================================

describe("MCP hardening — removed session mode", () => {
  it("`stateful: true` fails the boot instead of silently serving statelessly", async () => {
    const mcpPlugin = await loadMcpPlugin();
    const app = Fastify({ logger: false });
    await expect(
      app.register(mcpPlugin, { resources: [], auth: false, ...{ stateful: true } }),
    ).rejects.toThrow("mcpPlugin: `stateful: true` was removed — MCP 2026-07-28 has no sessions");
    await app.close().catch(() => {});
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
    expect(catalog).not.toBe(orders);
  });

  it("top-level getters (toolNames, resourceNames) read the first registration", async () => {
    // Back-compat for apps that only register one mcpPlugin and read
    // `app.mcp.toolNames` directly.
    const mcpPlugin = await loadMcpPlugin();

    app = Fastify({ logger: false });
    await app.register(mcpPlugin, { resources: [], auth: false });
    await app.ready();

    expect(Array.isArray(app.mcp?.toolNames)).toBe(true);
    expect(Array.isArray(app.mcp?.resourceNames)).toBe(true);
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
// DNS-rebinding protection — Host / Origin validation on the MCP routes
// ============================================================================

describe("MCP hardening — DNS-rebinding protection", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
    vi.restoreAllMocks();
  });

  // A 2026-07-28 `server/discover`: the envelope in `_meta` plus the
  // standard headers the SDK requires to agree with it.
  const DISCOVER = {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "c", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };

  async function build(opts: Record<string, unknown>) {
    const mcpPlugin = await loadMcpPlugin();
    const f = Fastify({ logger: false });
    await f.register(mcpPlugin, { resources: [], ...opts });
    await f.ready();
    return f;
  }

  const post = (f: FastifyInstance, headers: Record<string, string>) =>
    f.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
        ...headers,
      },
      payload: DISCOVER,
    });

  it("auth:false — a rebound Host is REFUSED (the attack this exists for)", async () => {
    // The attack: a page the developer visits POSTs to 127.0.0.1:<port>. If an
    // attacker-controlled name resolves to loopback the browser treats the
    // response as same-origin and can READ every tool's output. The forged
    // request carries the attacker's `Host` — which is the signal we reject on.
    app = await build({ auth: false });
    const res = await post(app, { host: "evil.example.com" });
    expect(res.statusCode).toBe(403);
    // JSON-RPC envelope, not arc's REST ErrorContract — the caller speaks JSON-RPC.
    expect(res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
  });

  it("auth:false — localhost Host is allowed (protection must not break dev)", async () => {
    app = await build({ auth: false });
    expect((await post(app, { host: "127.0.0.1:9000" })).statusCode).toBeLessThan(400);
  });

  it("a present but unlisted Origin is refused; an absent Origin passes", async () => {
    // Non-browser MCP clients send no Origin — rejecting those would break
    // every CLI client. Only a PRESENT, unlisted Origin is an attack signal.
    app = await build({ auth: false });
    expect(
      (await post(app, { host: "localhost", origin: "https://evil.example.com" })).statusCode,
    ).toBe(403);
    expect((await post(app, { host: "localhost" })).statusCode).toBeLessThan(400);
  });

  it("DEFAULTS OFF when auth is configured — else every production deploy 403s", async () => {
    // A real deployment answers on its own domain, whose Host is not localhost.
    // Defaulting protection on would reject it. With auth configured the
    // credential is the gate, so the default must be off.
    app = await build({ auth: async () => ({ userId: "u1" }) });
    expect((await post(app, { host: "mcp.example.com" })).statusCode).not.toBe(403);
  });

  it("opt-in works for a localhost server that DOES use auth", async () => {
    app = await build({ auth: async () => ({ userId: "u1" }), dnsRebindingProtection: {} });
    expect((await post(app, { host: "evil.example.com" })).statusCode).toBe(403);
  });

  it("`false` disables it for a deliberately-public auth:false endpoint", async () => {
    app = await build({ auth: false, dnsRebindingProtection: false });
    expect((await post(app, { host: "anything.example.com" })).statusCode).not.toBe(403);
  });

  it("allowedHosts names a real public deployment", async () => {
    app = await build({
      auth: false,
      dnsRebindingProtection: { allowedHosts: ["mcp.example.com"] },
    });
    expect((await post(app, { host: "mcp.example.com" })).statusCode).not.toBe(403);
    expect((await post(app, { host: "evil.example.com" })).statusCode).toBe(403);
  });

  it("the health probe is EXEMPT — guarding it would restart-loop k8s", async () => {
    // Probes send a Host nobody can enumerate ahead of time (pod IP, LB name).
    // The attack's prize is the tool surface on POST, not liveness.
    app = await build({ auth: false });
    const res = await app.inject({
      method: "GET",
      url: "/mcp/health",
      headers: { host: "10.1.2.3:8080" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("does NOT apply to routes the plugin does not own", async () => {
    // `fp()` skips encapsulation, so this hook registers on the PARENT scope and
    // fires for every route in the host app. The URL guard is what keeps arc's
    // MCP policy off the host's own routes — assert it, or a future edit that
    // drops the guard silently imposes Host validation app-wide.
    const mcpPlugin = await loadMcpPlugin();
    app = Fastify({ logger: false });
    await app.register(mcpPlugin, { resources: [], auth: false });
    app.get("/unrelated", async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/unrelated",
      headers: { host: "evil.example.com" },
    });
    expect(res.statusCode).toBe(200);
  });
});
