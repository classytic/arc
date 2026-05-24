/**
 * `mcpPlugin` boot WARN when `auth: false`.
 *
 * Real-world incident pattern (partner team flagged):
 *   1. Dev sets `auth: false` to skip OAuth setup during local development.
 *   2. The same Fastify app gets exposed through a public tunnel
 *      (Cloudflare Tunnel / ngrok / Tailscale Funnel) for demos or sharing.
 *   3. The MCP endpoint becomes a fully-anonymous remote CRUD + action
 *      surface across every resource registered — provider keys, tenant
 *      data, workflows, all reachable by anyone with the URL.
 *
 * Pre-fix, arc registered the plugin silently. Post-fix, one unmissable
 * WARN fires at every boot when `auth: false`, naming the prefix, the tool
 * count, and the first few tool names so the host sees the magnitude of
 * exposure in its log stream. Hosts who legitimately want auth-less MCP
 * (stdio transports, explicit public read-only APIs) can silence via
 * their logger configuration.
 */
import type { StandardRepo } from "@classytic/repo-core/repository";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineResource } from "../../../src/index.js";
import { mcpPlugin } from "../../../src/integrations/mcp/mcpPlugin.js";
import { allowPublic } from "../../../src/permissions/index.js";
import type { AnyRecord, DataAdapter } from "../../../src/types/index.js";

function stubAdapter(): DataAdapter {
  const repo: StandardRepo = {
    async getAll() {
      return [];
    },
    async getById() {
      return null;
    },
    async create(d: AnyRecord) {
      return { _id: "1", ...d };
    },
    async update(_: string, d: AnyRecord) {
      return { _id: "1", ...d };
    },
    async delete() {
      return true;
    },
  };
  return { repository: repo, type: "custom", name: "stub" };
}

function makeFastifyWithLogSpies(): {
  app: FastifyInstance;
  warnSpy: ReturnType<typeof vi.fn>;
} {
  const warnSpy = vi.fn();
  const app = Fastify({ logger: false });
  Object.defineProperty(app, "log", {
    value: {
      warn: warnSpy,
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child() {
        return app.log;
      },
    },
    writable: false,
    configurable: true,
  });
  return { app, warnSpy };
}

describe("mcpPlugin — auth: false WARN", () => {
  let app: FastifyInstance;
  let warnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const built = makeFastifyWithLogSpies();
    app = built.app;
    warnSpy = built.warnSpy;
  });

  afterEach(async () => {
    await app.close();
  });

  it("fires a loud WARN at boot when auth: false is passed", async () => {
    const resource = defineResource({
      name: "product",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(mcpPlugin, { resources: [resource], auth: false });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /auth DISABLED/.test(m))).toBe(true);
  });

  it("warning names the prefix, tool count, and first tool names", async () => {
    const resource = defineResource({
      name: "product",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(mcpPlugin, {
      resources: [resource],
      auth: false,
      prefix: "/mcp/danger",
    });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    const warning = messages.find((m) => /auth DISABLED/.test(m));
    expect(warning).toBeDefined();
    expect(warning).toContain("/mcp/danger");
    // At least one tool name should appear so the host sees the surface
    expect(warning).toMatch(/list_products|get_product|create_product/);
  });

  it("does NOT warn when auth is a function (custom auth)", async () => {
    const resource = defineResource({
      name: "product",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(mcpPlugin, {
      resources: [resource],
      auth: async () => ({ userId: "anonymous" }),
    });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /auth DISABLED/.test(m))).toBe(false);
  });

  it("warning fires once per registration (not per tool, not per resource)", async () => {
    const resource = defineResource({
      name: "thing",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(mcpPlugin, { resources: [resource], auth: false });
    await app.ready();

    const matchingWarns = warnSpy.mock.calls.filter((c) => /auth DISABLED/.test(String(c[0])));
    expect(matchingWarns.length).toBe(1);
  });

  it("multi-registration: each prefix with auth: false gets its own warning", async () => {
    const a = defineResource({
      name: "a",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });
    const b = defineResource({
      name: "b",
      adapter: stubAdapter(),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await app.register(mcpPlugin, { resources: [a], auth: false, prefix: "/mcp/a" });
    await app.register(mcpPlugin, { resources: [b], auth: false, prefix: "/mcp/b" });
    await app.ready();

    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some((m) => /mcp\/a.*auth DISABLED/.test(m) || /auth DISABLED.*mcp\/a/.test(m)),
    ).toBe(true);
    expect(
      messages.some((m) => /mcp\/b.*auth DISABLED/.test(m) || /auth DISABLED.*mcp\/b/.test(m)),
    ).toBe(true);
  });
});
