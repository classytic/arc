/**
 * audit plugin — per-resource opt-in tests
 *
 * Tests the cleaner DX where audit is opt-in per resource (no growing
 * exclude lists), plus the include allowlist mode.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { auditPlugin } from "../../src/audit/auditPlugin.js";
import { MemoryAuditStore } from "../../src/audit/stores/memory.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { HookSystem } from "../../src/hooks/HookSystem.js";

/**
 * Stub a resource into the registry so perResource mode can read its `audit` flag.
 * Bypasses the full defineResource pipeline (we're testing audit, not the registry).
 */
function stubResource(arc: { registry: { register?: unknown } }, name: string, audit?: unknown) {
  const reg = arc.registry as unknown as { _resources: Map<string, unknown> };
  reg._resources.set(name, {
    name,
    displayName: name,
    tag: name,
    prefix: `/${name}s`,
    presets: [],
    routes: [],
    events: [],
    audit,
  });
}

describe("audit plugin — per-resource opt-in", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    app = null;
  });

  async function setup(autoAudit: unknown, stubs: Array<{ name: string; audit?: unknown }>) {
    const store = new MemoryAuditStore();
    const hookSystem = new HookSystem({ logger: { error: () => {} } });
    app = Fastify({ logger: false });
    await app.register(arcCorePlugin, { hookSystem });

    // Stub resources BEFORE auditPlugin's onReady fires
    for (const s of stubs) {
      // biome-ignore lint: accessing private registry for test setup
      stubResource((app as any).arc, s.name, s.audit);
    }

    await app.register(auditPlugin, {
      enabled: true,
      stores: [],
      customStores: [store],
      // biome-ignore lint: passing through autoAudit shapes
      autoAudit: autoAudit as any,
    });
    await app.ready();
    return { store, hookSystem };
  }

  // ── perResource mode ──

  it("perResource: only resources with audit: true are audited", async () => {
    const { store, hookSystem } = await setup({ perResource: true }, [
      { name: "AuditedRes", audit: true },
      { name: "UnauditedRes" },
    ]);

    await hookSystem.executeAfter("AuditedRes", "create", { _id: "a1", name: "x" });
    await hookSystem.executeAfter("UnauditedRes", "create", { _id: "u1", name: "y" });
    await new Promise((r) => setTimeout(r, 50));

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].resource).toBe("AuditedRes");
  });

  it("perResource: { operations: ['delete'] } only audits deletes", async () => {
    const { store, hookSystem } = await setup({ perResource: true }, [
      { name: "DelOnly", audit: { operations: ["delete"] } },
    ]);

    await hookSystem.executeAfter("DelOnly", "create", { _id: "d1", name: "x" });
    await hookSystem.executeAfter("DelOnly", "update", { _id: "d1", name: "y" });
    await hookSystem.executeAfter("DelOnly", "delete", { _id: "d1", name: "y" });
    await new Promise((r) => setTimeout(r, 50));

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("delete");
  });

  it("perResource mode ignores resources without audit flag", async () => {
    const { store, hookSystem } = await setup({ perResource: true }, [{ name: "NoFlag" }]);

    await hookSystem.executeAfter("NoFlag", "create", { _id: "n1", name: "x" });
    await new Promise((r) => setTimeout(r, 50));

    expect(store.getAll()).toHaveLength(0);
  });

  // ── include allowlist mode ──

  it("include allowlist: only listed resources audited", async () => {
    const { store, hookSystem } = await setup({ include: ["AllowA", "AllowC"] }, [
      { name: "AllowA" },
      { name: "AllowB" },
      { name: "AllowC" },
    ]);

    await hookSystem.executeAfter("AllowA", "create", { _id: "a1" });
    await hookSystem.executeAfter("AllowB", "create", { _id: "b1" });
    await hookSystem.executeAfter("AllowC", "create", { _id: "c1" });
    await new Promise((r) => setTimeout(r, 50));

    const names = store
      .getAll()
      .map((e) => e.resource)
      .sort();
    expect(names).toEqual(["AllowA", "AllowC"]);
  });

  // ── exclude denylist mode (legacy) ──

  it("exclude denylist: skip listed resources", async () => {
    const { store, hookSystem } = await setup({ exclude: ["DenyB"] }, [
      { name: "DenyA" },
      { name: "DenyB" },
    ]);

    await hookSystem.executeAfter("DenyA", "create", { _id: "a1" });
    await hookSystem.executeAfter("DenyB", "create", { _id: "b1" });
    await new Promise((r) => setTimeout(r, 50));

    const entries = store.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].resource).toBe("DenyA");
  });

  // ── default true mode (audit everything) ──

  it("default (true): audits all resources", async () => {
    const { store, hookSystem } = await setup(true, [{ name: "DefA" }, { name: "DefB" }]);

    await hookSystem.executeAfter("DefA", "create", { _id: "a1" });
    await hookSystem.executeAfter("DefB", "create", { _id: "b1" });
    await new Promise((r) => setTimeout(r, 50));

    expect(store.getAll()).toHaveLength(2);
  });

  // ── include + exclude conflict ──

  it("include wins over exclude when both specified (with warning)", async () => {
    const { store, hookSystem } = await setup({ include: ["X"], exclude: ["X"] }, [
      { name: "X" },
      { name: "Y" },
    ]);

    await hookSystem.executeAfter("X", "create", { _id: "x1" });
    await hookSystem.executeAfter("Y", "create", { _id: "y1" });
    await new Promise((r) => setTimeout(r, 50));

    // include wins — only X is audited
    expect(store.getAll().map((e) => e.resource)).toEqual(["X"]);
  });
});
