/**
 * `defineResource({ idempotency: { required } })` fences BUILT-IN write routes and
 * `actions.<name>.idempotency.required` fences one action on the shared mount: keyless is
 * 400 `arc.idempotency_key_required`, a keyed retry replays, DELETE included. The fence is
 * published on the registry entry and in OpenAPI, and boot refuses a fence nothing enforces.
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineAction } from "../../src/core/defineAction.js";
import { defineResource } from "../../src/core/defineResource.js";
import { buildOpenApiSpec } from "../../src/docs/openapi/index.js";
import { idempotencyPlugin } from "../../src/idempotency/idempotencyPlugin.js";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";
import type { ResourceIdempotencyConfig } from "../../src/types/index.js";

interface Doc {
  _id: string;
  amount?: number;
}

const runs = { create: 0, update: 0, delete: 0, pay: 0, note: 0 };

function stubAdapter(): DataAdapter<Doc> {
  return {
    type: "custom",
    name: "stub",
    repository: {
      create: async (data) => {
        runs.create += 1;
        return { _id: `doc-${runs.create}`, ...data };
      },
      getById: async (id) => ({ _id: id }),
      getAll: async () => [],
      update: async (id, data) => {
        runs.update += 1;
        return { _id: id, ...data };
      },
      delete: async () => {
        runs.delete += 1;
        return { success: true };
      },
    },
  };
}

function ledger(
  idempotency: ResourceIdempotencyConfig | undefined = { required: ["create", "delete"] },
  disabledRoutes: readonly ("list" | "get" | "create" | "update" | "delete")[] = [],
) {
  const open = allowPublic();
  return defineResource({
    name: "ledger",
    prefix: "/ledger",
    tenantField: false,
    adapter: stubAdapter(),
    permissions: { list: open, get: open, create: open, update: open, delete: open },
    disabledRoutes,
    ...(idempotency ? { idempotency } : {}),
    actions: {
      pay: {
        handler: async () => ({ run: ++runs.pay }),
        permissions: open,
        idempotency: { required: true },
      },
      note: { handler: async () => ({ run: ++runs.note }), permissions: open },
      settle: defineAction({
        handler: async () => ({ run: ++runs.pay }),
        permissions: open,
        idempotency: { required: true },
      }),
      refund: {
        handler: async () => ({ ok: true }),
        permissions: requireRoles(["admin"]),
        idempotency: { required: true },
      },
    },
  });
}

let host: FastifyInstance | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
  for (const k of Object.keys(runs) as (keyof typeof runs)[]) runs[k] = 0;
});

async function boot(resource = ledger()): Promise<FastifyInstance> {
  host = Fastify({ logger: false });
  await host.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
  await host.register(resource.toPlugin());
  await host.ready();
  return host;
}

const keyRequired = (res: { statusCode: number; json: () => unknown }) => {
  expect(res.statusCode).toBe(400);
  expect((res.json() as { code?: string }).code).toBe("arc.idempotency_key_required");
};

describe("built-in routes declared in idempotency.required", () => {
  it("create: keyless refused, a keyed retry replays", async () => {
    const app = await boot();
    keyRequired(await app.inject({ method: "POST", url: "/ledger", payload: { amount: 1 } }));
    expect(runs.create).toBe(0);
    const call = () =>
      app.inject({
        method: "POST",
        url: "/ledger",
        headers: { "idempotency-key": "c1" },
        payload: { amount: 1 },
      });
    expect((await call()).statusCode).toBe(201);
    expect((await call()).headers["x-idempotency-replayed"]).toBe("true");
    expect(runs.create).toBe(1);
  });

  it("delete: keyless refused, a keyed retry replays (DELETE is outside the default methods)", async () => {
    const app = await boot();
    keyRequired(await app.inject({ method: "DELETE", url: "/ledger/d1" }));
    expect(runs.delete).toBe(0);
    const call = () =>
      app.inject({ method: "DELETE", url: "/ledger/d1", headers: { "idempotency-key": "x1" } });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).headers["x-idempotency-replayed"]).toBe("true");
    expect(runs.delete).toBe(1);
  });

  it("an op not listed stays optional", async () => {
    const app = await boot();
    const res = await app.inject({ method: "PATCH", url: "/ledger/u1", payload: { amount: 2 } });
    expect(res.statusCode).toBe(200);
  });
});

describe("actions declaring idempotency.required", () => {
  it("fences only the declared action on the shared mount", async () => {
    const app = await boot();
    keyRequired(
      await app.inject({ method: "POST", url: "/ledger/a1/action", payload: { action: "pay" } }),
    );
    expect(runs.pay).toBe(0);
    const note = await app.inject({
      method: "POST",
      url: "/ledger/a1/action",
      payload: { action: "note" },
    });
    expect(note.statusCode).toBe(200);

    const pay = () =>
      app.inject({
        method: "POST",
        url: "/ledger/a1/action",
        headers: { "idempotency-key": "p1" },
        payload: { action: "pay" },
      });
    expect((await pay()).json()).toEqual({ run: 1 });
    expect((await pay()).json()).toEqual({ run: 1 });
    expect(runs.pay).toBe(1);
  });

  it("the permission gate answers first: a refused keyless caller gets 401/403, not the key code", async () => {
    const app = await boot();
    const res = await app.inject({
      method: "POST",
      url: "/ledger/a1/action",
      payload: { action: "refund" },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe("defineAction carries the declaration", () => {
  it("a defineAction-built action refuses keyless and is listed on the mount's route config", async () => {
    const mounts: Array<{ url: string; config?: { idempotency?: unknown } }> = [];
    host = Fastify({ logger: false });
    host.addHook("onRoute", (r) => {
      mounts.push({ url: r.url, config: r.config });
    });
    await host.register(idempotencyPlugin, { enabled: true, ttlMs: 60_000 });
    await host.register(ledger().toPlugin());
    await host.ready();
    keyRequired(
      await host.inject({
        method: "POST",
        url: "/ledger/a1/action",
        payload: { action: "settle" },
      }),
    );
    expect(runs.pay).toBe(0);
    expect(mounts.find((m) => m.url === "/ledger/:id/action")?.config?.idempotency).toEqual({
      requiredActions: ["pay", "settle", "refund"],
    });
  });
});

describe("introspection", () => {
  it("the registry entry and OpenAPI publish every fence", () => {
    const registry = new ResourceRegistry();
    registry.register(ledger());
    const entry = registry.get("ledger");
    expect(entry?.idempotency).toEqual({ required: ["create", "delete"] });
    const byName = Object.fromEntries((entry?.actions ?? []).map((a) => [a.name, a.idempotency]));
    expect(byName).toEqual({
      pay: { required: true },
      note: undefined,
      settle: { required: true },
      refund: { required: true },
    });

    const spec = buildOpenApiSpec(entry ? [entry] : []);
    expect(spec.paths["/ledger"]?.post?.["x-arc-idempotency"]).toEqual({ required: true });
    expect(spec.paths["/ledger/{id}"]?.delete?.["x-arc-idempotency"]).toEqual({ required: true });
    expect(spec.paths["/ledger/{id}"]?.patch?.["x-arc-idempotency"]).toBeUndefined();
    expect(spec.paths["/ledger/{id}/action"]?.post?.["x-arc-idempotency"]).toEqual({
      requiredActions: ["pay", "settle", "refund"],
    });
  });
});

async function mount(app: FastifyInstance): Promise<void> {
  await app.register(ledger().toPlugin());
  await app.ready();
}

describe("boot refuses a fence nothing enforces", () => {
  it("a required op whose route is disabled", async () => {
    await expect(boot(ledger({ required: ["delete"] }, ["delete"]))).rejects.toThrow(/not mounted/);
  });

  it("the plugin disabled", async () => {
    host = Fastify({ logger: false });
    await host.register(idempotencyPlugin, { enabled: false });
    await expect(mount(host)).rejects.toThrow(/disabled/);
  });

  it("no plugin at all", async () => {
    host = Fastify({ logger: false });
    await expect(mount(host)).rejects.toThrow(/idempotencyPlugin is not registered/);
  });
});
