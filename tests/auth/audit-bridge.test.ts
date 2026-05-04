/**
 * Better Auth → arc audit bridge — wireBetterAuthAudit
 *
 * Verifies the BA-hook → audit-row contract end to end without spinning
 * up a full BA + Mongo stack: synthetic hook context + an in-memory
 * audit store catches every dispatched row.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPlugin } from "../../src/audit/auditPlugin.js";
import type { AuditEntry } from "../../src/audit/stores/interface.js";
import { wireBetterAuthAudit } from "../../src/auth/audit.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";

async function setupApp(events?: readonly string[]): Promise<{
  app: FastifyInstance;
  bridge: ReturnType<typeof wireBetterAuthAudit>;
  rows: AuditEntry[];
}> {
  const rows: AuditEntry[] = [];
  const bridge = wireBetterAuthAudit({
    events: events ?? ["session.*", "user.*", "mfa.*", "org.*"],
  });
  const hookSystem = new HookSystem({ logger: { error: () => {} } });
  const app = Fastify({ logger: false });
  await app.register(arcCorePlugin, { hookSystem });
  await app.register(auditPlugin, {
    enabled: true,
    customStores: [
      {
        name: "test",
        async log(entry) {
          rows.push(entry);
        },
      },
    ],
  });
  await app.ready();
  bridge.attach(app);
  return { app, bridge, rows };
}

describe("wireBetterAuthAudit — databaseHooks (sign-in/up/out)", () => {
  let s: Awaited<ReturnType<typeof setupApp>>;
  beforeEach(async () => {
    s = await setupApp();
  });
  afterEach(async () => {
    await s.app.close();
  });

  it("session.create.after → audit row with action='session.create'", async () => {
    await s.bridge.databaseHooks.session.create.after({
      id: "sess_1",
      userId: "user_1",
      activeOrganizationId: "org_acme",
      ipAddress: "10.0.0.1",
      userAgent: "Mozilla/5.0",
    });

    // Bridge dispatches asynchronously — give it a microtask
    await new Promise((r) => setTimeout(r, 5));
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]?.resource).toBe("auth");
    expect(s.rows[0]?.documentId).toBe("sess_1");
    expect(s.rows[0]?.metadata?.customAction).toBe("session.create");
    expect(s.rows[0]?.organizationId).toBe("org_acme");
  });

  it("session.delete.after → audit row with action='session.delete'", async () => {
    await s.bridge.databaseHooks.session.delete?.after?.({
      id: "sess_1",
      userId: "user_1",
      activeOrganizationId: "org_acme",
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.rows[0]?.metadata?.customAction).toBe("session.delete");
  });

  it("user.create.after → audit row with action='user.create'", async () => {
    await s.bridge.databaseHooks.user.create.after({ id: "user_99" });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.rows[0]?.documentId).toBe("user_99");
    expect(s.rows[0]?.metadata?.customAction).toBe("user.create");
  });
});

describe("wireBetterAuthAudit — endpoint hooks (MFA, OAuth, password reset)", () => {
  let s: Awaited<ReturnType<typeof setupApp>>;
  beforeEach(async () => {
    s = await setupApp();
  });
  afterEach(async () => {
    await s.app.close();
  });

  it("classifies /two-factor/verify after-hook as 'mfa.verify'", async () => {
    await s.bridge.hooks.after({
      path: "/two-factor/verify-totp",
      method: "POST",
      context: { session: { user: { id: "u1" }, activeOrganizationId: "org_acme" } },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.rows[0]?.metadata?.customAction).toBe("mfa.verify");
  });

  it("classifies /organization/create after-hook as 'org.create'", async () => {
    await s.bridge.hooks.after({
      path: "/organization/create",
      method: "POST",
      context: { session: { user: { id: "u1" } } },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.rows[0]?.metadata?.customAction).toBe("org.create");
  });

  it("ignores endpoints we don't classify (no row written)", async () => {
    await s.bridge.hooks.after({
      path: "/some/random/endpoint",
      method: "GET",
      context: { session: {} },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.rows).toHaveLength(0);
  });

  it("asPluginHooks() returns the array form for plugin authors", async () => {
    const pluginHooks = s.bridge.asPluginHooks();
    expect(pluginHooks.before).toHaveLength(1);
    expect(pluginHooks.after).toHaveLength(1);
    expect(typeof pluginHooks.after[0]?.handler).toBe("function");
    // Plugin form fires through the same dispatcher
    await pluginHooks.after[0]?.handler({
      path: "/two-factor/disable",
      method: "POST",
      context: { session: { user: { id: "u1" } } },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.rows[0]?.metadata?.customAction).toBe("mfa.disable");
  });
});

describe("wireBetterAuthAudit — event filtering", () => {
  it("respects the events allowlist", async () => {
    const s = await setupApp(["session.create"]);
    try {
      await s.bridge.databaseHooks.session.create.after({ id: "s1", userId: "u1" });
      await s.bridge.databaseHooks.user.create.after({ id: "u1" });
      await new Promise((r) => setTimeout(r, 5));
      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]?.metadata?.customAction).toBe("session.create");
    } finally {
      await s.app.close();
    }
  });

  it("supports glob wildcards", async () => {
    const s = await setupApp(["session.*"]);
    try {
      await s.bridge.databaseHooks.session.create.after({ id: "s1" });
      await s.bridge.databaseHooks.session.delete?.after?.({ id: "s1" });
      await s.bridge.databaseHooks.user.create.after({ id: "u1" });
      await new Promise((r) => setTimeout(r, 5));
      expect(s.rows.map((r) => r.metadata?.customAction).sort()).toEqual([
        "session.create",
        "session.delete",
      ]);
    } finally {
      await s.app.close();
    }
  });
});

describe("wireBetterAuthAudit — buffer + attach drain", () => {
  it("buffers events fired before attach() and flushes on attach", async () => {
    const rows: AuditEntry[] = [];
    const bridge = wireBetterAuthAudit({ events: ["session.*"] });

    // Fire BEFORE attach — should buffer, not throw
    await bridge.databaseHooks.session.create.after({ id: "s1", userId: "u1" });
    await bridge.databaseHooks.session.create.after({ id: "s2", userId: "u2" });

    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    const app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      customStores: [
        {
          name: "t",
          async log(entry) {
            rows.push(entry);
          },
        },
      ],
    });
    await app.ready();
    bridge.attach(app); // drain happens here

    await new Promise((r) => setTimeout(r, 10));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.documentId).sort()).toEqual(["s1", "s2"]);
    await app.close();
  });
});

describe("wireBetterAuthAudit — buffer eviction (FIFO when full)", () => {
  it("drops oldest events when buffer fills, surfaces droppedFromBuffer in stats", async () => {
    const bridge = wireBetterAuthAudit({ events: ["session.*"], bufferSize: 3 });

    // Fire 5 events BEFORE attach — buffer holds 3, oldest 2 evicted.
    for (let i = 1; i <= 5; i++) {
      await bridge.databaseHooks.session.create.after({ id: `s${i}`, userId: `u${i}` });
    }

    expect(bridge.getStats().droppedFromBuffer).toBe(2);
    expect(bridge.getStats().pendingBuffered).toBe(3);

    const rows: AuditEntry[] = [];
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    const app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      customStores: [
        {
          name: "t",
          async log(entry) {
            rows.push(entry);
          },
        },
      ],
    });
    await app.ready();
    bridge.attach(app);
    await new Promise((r) => setTimeout(r, 10));

    // Only the LAST 3 events should make it through.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.documentId).sort()).toEqual(["s3", "s4", "s5"]);
    await app.close();
  });

  it("getStats returns zero counters on a fresh bridge", () => {
    const bridge = wireBetterAuthAudit({});
    expect(bridge.getStats()).toEqual({
      droppedFromBuffer: 0,
      dispatchFailures: 0,
      dispatchAttempts: 0,
      pendingBuffered: 0,
    });
  });

  it("counts dispatch failures when the audit store throws", async () => {
    const bridge = wireBetterAuthAudit({ events: ["session.*"] });
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    const app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      customStores: [
        {
          name: "fail",
          async log() {
            throw new Error("store unavailable");
          },
        },
      ],
    });
    await app.ready();
    bridge.attach(app);

    await bridge.databaseHooks.session.create.after({ id: "s1", userId: "u1" });
    await new Promise((r) => setTimeout(r, 5));

    expect(bridge.getStats().dispatchFailures).toBeGreaterThanOrEqual(1);
    await app.close();
  });
});

describe("wireBetterAuthAudit — transform hook", () => {
  it("can drop events by returning null", async () => {
    const rows: AuditEntry[] = [];
    const bridge = wireBetterAuthAudit({
      events: ["session.*"],
      transform: (event) => (event.subjectId === "blocked" ? null : event),
    });
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    const app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      customStores: [
        {
          name: "t",
          async log(entry) {
            rows.push(entry);
          },
        },
      ],
    });
    await app.ready();
    bridge.attach(app);

    await bridge.databaseHooks.session.create.after({ id: "ok", userId: "u1" });
    await bridge.databaseHooks.session.create.after({ id: "blocked", userId: "u2" });
    await new Promise((r) => setTimeout(r, 5));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.documentId).toBe("ok");
    await app.close();
  });

  it("manual emit() works for non-BA flows", async () => {
    const s = await setupApp(["**"]);
    try {
      s.bridge.emit({
        name: "webhook.signature.failed",
        subjectId: "wh_1",
        payload: { provider: "stripe" },
      });
      await new Promise((r) => setTimeout(r, 5));
      expect(s.rows[0]?.metadata?.customAction).toBe("webhook.signature.failed");
    } finally {
      await s.app.close();
    }
  });
});
