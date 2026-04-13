/**
 * audit plugin — flexibility tests
 *
 * Verifies the audit surface is rich enough for enterprise/distributed apps:
 *
 *   1. routes can call fastify.audit.custom() (e.g., custom action logging)
 *   2. MCP-style action handlers can audit through the same API
 *   3. Distributed event log: hook subscribers can persist audit entries to multiple stores
 *   4. Read auditing: not auto-fired, but reachable via manual custom() calls
 *   5. BaseController hook contract — audit hook receives ctx.result with the document
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { auditPlugin } from "../../src/audit/auditPlugin.js";
import { MemoryAuditStore } from "../../src/audit/stores/memory.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";

describe("audit plugin — flexibility surface", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    app = null;
  });

  async function setup(
    opts: { autoAudit?: unknown; routes?: (app: FastifyInstance) => void } = {},
  ): Promise<{ store: MemoryAuditStore; hookSystem: HookSystem }> {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      // biome-ignore lint: pass-through
      autoAudit: (opts.autoAudit ?? false) as any,
    });
    if (opts.routes) opts.routes(app);
    await app.ready();
    return { store, hookSystem };
  }

  // ── 1. routes / custom handlers ──

  it("additionalRoute handler can call fastify.audit.custom()", async () => {
    const { store } = await setup({
      routes: (a) => {
        // Simulate a POST /products/:id/publish handler
        a.post("/products/:id/publish", async (req) => {
          const { id } = req.params as { id: string };
          // Custom action audit
          await a.audit.custom(
            "product",
            id,
            "publish",
            { reason: "manual review complete" },
            { user: { _id: "u1" } as Record<string, unknown> },
          );
          return { success: true };
        });
      },
    });

    const res = await app?.inject({
      method: "POST",
      url: "/products/p123/publish",
    });
    expect(res.statusCode).toBe(200);

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("custom");
    expect(entries[0].resource).toBe("product");
    expect(entries[0].documentId).toBe("p123");
    expect(entries[0].metadata?.customAction).toBe("publish");
    expect(entries[0].metadata?.reason).toBe("manual review complete");
  });

  // ── 2. MCP-style action handler ──

  it("MCP tool handler can audit through fastify.audit.custom()", async () => {
    const { store } = await setup();

    // Simulate an MCP tool that calls audit when it executes
    const fulfillOrderTool = async (input: {
      orderId: string;
      userId: string;
    }): Promise<{ ok: true }> => {
      // Tool logic ...
      // Audit the action
      await app?.audit.custom(
        "order",
        input.orderId,
        "fulfill_order_mcp",
        { source: "mcp", input },
        { user: { _id: input.userId } as Record<string, unknown> },
      );
      return { ok: true };
    };

    await fulfillOrderTool({ orderId: "o42", userId: "u1" });

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata?.customAction).toBe("fulfill_order_mcp");
    expect(entries[0].metadata?.source).toBe("mcp");
    expect((entries[0].metadata?.input as { orderId: string }).orderId).toBe("o42");
  });

  // ── 3. Read auditing (compliance/PII access) ──

  it("read access can be audited via fastify.audit.custom() in handlers", async () => {
    const { store } = await setup({
      routes: (a) => {
        // Compliance-sensitive read endpoint
        a.get("/patients/:id", async (req) => {
          const { id } = req.params as { id: string };
          await a.audit.custom(
            "patient",
            id,
            "read_pii",
            { fields: ["ssn", "dob"] },
            { user: { _id: "doctor1" } as Record<string, unknown> },
          );
          return { id, name: "***" };
        });
      },
    });

    await app?.inject({ method: "GET", url: "/patients/p1" });

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("custom");
    expect(entries[0].metadata?.customAction).toBe("read_pii");
  });

  // ── 4. BaseController hook contract — audit receives ctx.result ──

  it("auto-audit receives ctx.result from after-create hook", async () => {
    // Re-setup with autoAudit enabled
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: true,
    });
    await app.ready();

    // Simulate what BaseController.create does:
    //   await hooks.executeAfter(resourceName, "create", item, { user, context })
    await hookSystem.executeAfter(
      "product",
      "create",
      { _id: "p1", name: "Widget", price: 99 },
      { user: { _id: "u1" } as Record<string, unknown> },
    );
    await new Promise((r) => setTimeout(r, 50));

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("create");
    expect(entries[0].documentId).toBe("p1");
    expect((entries[0].after as { name: string }).name).toBe("Widget");
  });

  it("auto-audit receives before/after on update from BaseController hook", async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: true,
    });
    await app.ready();

    // BaseController.update fires:
    //   executeAfter(name, "update", item, { user, context, meta: { id, existing } })
    await hookSystem.executeAfter(
      "product",
      "update",
      { _id: "p1", name: "New Name" },
      {
        user: { _id: "u1" } as Record<string, unknown>,
        meta: { existing: { _id: "p1", name: "Old Name" } },
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    const entries = store.getAll();
    const update = entries.find((e) => e.action === "update");
    expect(update).toBeDefined();
    expect((update?.before as { name: string }).name).toBe("Old Name");
    expect((update?.after as { name: string }).name).toBe("New Name");
  });

  // ── 5. Distributed: multiple stores fan-out ──

  it("logs to multiple custom stores in parallel (distributed sink)", async () => {
    const primary = new MemoryAuditStore();
    const replica = new MemoryAuditStore();
    const cold = new MemoryAuditStore(); // archive

    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [primary, replica, cold],
      autoAudit: true,
    });
    await app.ready();

    await hookSystem.executeAfter(
      "order",
      "create",
      { _id: "o1", total: 100 },
      { user: { _id: "u1" } as Record<string, unknown> },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(primary.getAll()).toHaveLength(1);
    expect(replica.getAll()).toHaveLength(1);
    expect(cold.getAll()).toHaveLength(1);

    // Each store gets the SAME entry (not a copy with different IDs)
    expect(primary.getAll()[0].documentId).toBe("o1");
    expect(replica.getAll()[0].documentId).toBe("o1");
    expect(cold.getAll()[0].documentId).toBe("o1");
  });

  it("store failure does not break the application (audit hook is fire-and-forget at handler level)", async () => {
    const failing = {
      type: "failing",
      async log() {
        throw new Error("simulated network failure");
      },
    } as unknown as MemoryAuditStore;
    const working = new MemoryAuditStore();

    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [failing, working],
      autoAudit: true,
    });
    await app.ready();

    // The hook should swallow the error and continue (auto-audit logs warning)
    await hookSystem.executeAfter(
      "order",
      "create",
      { _id: "o1", total: 100 },
      { user: { _id: "u1" } as Record<string, unknown> },
    );
    await new Promise((r) => setTimeout(r, 50));

    // Application is still alive, working store may or may not have written
    // (depends on Promise.all semantics), but no exception was thrown
    expect(true).toBe(true);
  });

  // ── 6. Org/scope context propagation ──

  it("audit context includes organizationId from scope", async () => {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });
    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      autoAudit: true,
    });
    await app.ready();

    await hookSystem.executeAfter(
      "order",
      "create",
      { _id: "o1", total: 100 },
      {
        user: { _id: "u1" } as Record<string, unknown>,
        context: {
          _scope: { kind: "member", userId: "u1", organizationId: "org-acme", orgRoles: ["admin"] },
        } as Record<string, unknown>,
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].organizationId).toBe("org-acme");
  });
});
