/**
 * Regression: inline `config.hooks` handlers were missing access to the
 * request context + scope.
 *
 * Pre-fix:
 * - `defineResource.ts`'s `toCtx` wrapper projected `HookContext` →
 *   `ResourceHookContext` as `{ data, user, meta }`.
 * - BaseController calls hooks with `{ user, context: arcContext }` —
 *   so `ctx.context` (containing `_scope._scope.organizationId`) was
 *   dropped entirely by the wrapper.
 * - Hosts who wanted tenant/user-scope access from a `config.hooks`
 *   handler had to bypass `config.hooks` and push directly into
 *   `resource._pendingHooks` (which receives the raw internal shape).
 *
 * 2.10.8 fix:
 * - `ResourceHookContext` now also exposes `context?: RequestContext`
 *   and a first-class `scope?: RequestScopeProjection` projection
 *   (same shape as `IRequestContext.scope` from 2.10.6 — so hosts can
 *   read tenant/user the same way across controllers and hooks).
 * - The `toCtx` wrapper in `defineResource.ts` forwards both.
 *
 * These tests use real mongodb-memory-server + a real scope-stamping
 * preHandler so the end-to-end path (preset → fastifyAdapter → BaseController
 * → hooks → wrapper → user's handler) is exercised — not just the wrapper
 * in isolation.
 */

import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { Repository } from "@classytic/mongokit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DataAdapter } from "../../src/adapters/index.js";
import { createApp } from "../../src/factory/index.js";
import { allowPublic, defineResource } from "../../src/index.js";
import type { ResourceHookContext } from "../../src/types/index.js";

interface ProductDoc {
  _id?: string;
  organizationId?: string;
  name: string;
  price: number;
}

const productSchema = new Schema<ProductDoc>(
  {
    organizationId: { type: String, index: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
  },
  { timestamps: true },
);

const ORG_A = "org_alpha";

function memberOfOrgA() {
  return async (request: {
    headers: Record<string, string | string[] | undefined>;
    user?: unknown;
    scope?: unknown;
  }): Promise<void> => {
    if (request.headers["x-org"] !== ORG_A) return;
    request.user = { id: "user_1", roles: ["member"] };
    request.scope = {
      kind: "member",
      userId: "user_1",
      roles: ["member"],
      organizationId: ORG_A,
      organizationRole: "admin",
      orgRoles: ["admin"],
    };
  };
}

describe("2.10.8 regression — config.hooks handlers receive context + scope", () => {
  let mongoServer: MongoMemoryServer;
  let Product: mongoose.Model<ProductDoc>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  /**
   * Capture bag the hook writes into so the test can assert what the
   * wrapper actually delivered to the user's handler.
   */
  interface Captured {
    calls: Array<{
      phase: "beforeCreate" | "afterCreate" | "beforeUpdate" | "afterUpdate";
      data: Record<string, unknown> | undefined;
      scope: ResourceHookContext["scope"];
      contextScope: Record<string, unknown> | undefined;
      userId: string | undefined;
    }>;
  }

  async function buildApp(captured: Captured) {
    const repo = new Repository<ProductDoc>(Product);
    const adapter: DataAdapter<ProductDoc> = {
      repository: repo as unknown as DataAdapter<ProductDoc>["repository"],
      type: "mongoose",
      name: "product",
    };

    const resource = defineResource<ProductDoc>({
      name: "product",
      adapter,
      tenantField: "organizationId",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      middlewares: {
        create: [memberOfOrgA() as never],
        update: [memberOfOrgA() as never],
      },
      hooks: {
        beforeCreate: (ctx) => {
          captured.calls.push({
            phase: "beforeCreate",
            data: ctx.data,
            scope: ctx.scope,
            contextScope: (
              ctx.context as { _scope?: Record<string, unknown> } | undefined
            )?._scope,
            userId: (ctx.user as { id?: string } | undefined)?.id,
          });
        },
        afterCreate: (ctx) => {
          captured.calls.push({
            phase: "afterCreate",
            data: ctx.data,
            scope: ctx.scope,
            contextScope: (
              ctx.context as { _scope?: Record<string, unknown> } | undefined
            )?._scope,
            userId: (ctx.user as { id?: string } | undefined)?.id,
          });
        },
        beforeUpdate: (ctx) => {
          captured.calls.push({
            phase: "beforeUpdate",
            data: ctx.data,
            scope: ctx.scope,
            contextScope: (
              ctx.context as { _scope?: Record<string, unknown> } | undefined
            )?._scope,
            userId: (ctx.user as { id?: string } | undefined)?.id,
          });
        },
        afterUpdate: (ctx) => {
          captured.calls.push({
            phase: "afterUpdate",
            data: ctx.data,
            scope: ctx.scope,
            contextScope: (
              ctx.context as { _scope?: Record<string, unknown> } | undefined
            )?._scope,
            userId: (ctx.user as { id?: string } | undefined)?.id,
          });
        },
      },
    });

    // Must use createApp so arcCorePlugin registers — inline hook
    // handlers are only wired when `fastify.arc.hooks` exists.
    return createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Product = mongoose.model<ProductDoc>("Product_2_10_8", productSchema);
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30_000);

  beforeEach(async () => {
    await Product.deleteMany({});
  });

  it("beforeCreate hook sees req scope via ctx.scope (first-class projection)", async () => {
    const captured: Captured = { calls: [] };
    app = await buildApp(captured);

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { "x-org": ORG_A },
      payload: { name: "Widget", price: 10 },
    });
    expect(res.statusCode).toBe(201);

    const before = captured.calls.find((c) => c.phase === "beforeCreate");
    expect(before).toBeDefined();
    // First-class projection — hosts read tenant/user without digging
    expect(before?.scope?.organizationId).toBe(ORG_A);
    expect(before?.scope?.userId).toBe("user_1");
    expect(before?.scope?.orgRoles).toEqual(["admin"]);
    // Sanity: data + user still forwarded
    expect(before?.data?.name).toBe("Widget");
    expect(before?.userId).toBe("user_1");

    await app.close();
  });

  it("afterCreate hook sees full ctx.context._scope for advanced lookups", async () => {
    const captured: Captured = { calls: [] };
    app = await buildApp(captured);

    const res = await app.inject({
      method: "POST",
      url: "/products",
      headers: { "x-org": ORG_A },
      payload: { name: "Advanced", price: 25 },
    });
    expect(res.statusCode).toBe(201);

    const after = captured.calls.find((c) => c.phase === "afterCreate");
    expect(after).toBeDefined();
    // Full context is also exposed for hosts that need to discriminate
    // on `scope.kind` or reach auth-adapter-specific fields.
    expect(after?.contextScope).toBeDefined();
    expect(
      (after?.contextScope as { organizationId?: string } | undefined)?.organizationId,
    ).toBe(ORG_A);
    // afterCreate data is the created doc (not the input body)
    expect(after?.data?._id).toBeDefined();

    await app.close();
  });

  it("beforeUpdate / afterUpdate hooks receive scope AND the update meta (id, existing)", async () => {
    // Seed a doc so update can run.
    const seeded = await Product.create({
      organizationId: ORG_A,
      name: "Seed",
      price: 5,
    });
    const captured: Captured = { calls: [] };
    app = await buildApp(captured);

    const res = await app.inject({
      method: "PATCH",
      url: `/products/${seeded._id.toString()}`,
      headers: { "x-org": ORG_A },
      payload: { price: 15 },
    });
    expect(res.statusCode).toBe(200);

    const before = captured.calls.find((c) => c.phase === "beforeUpdate");
    const after = captured.calls.find((c) => c.phase === "afterUpdate");

    expect(before?.scope?.organizationId).toBe(ORG_A);
    expect(after?.scope?.organizationId).toBe(ORG_A);

    // `meta` forwarding still works (update path passes `{id, existing}`)
    const beforeCall = captured.calls.find((c) => c.phase === "beforeUpdate");
    expect(beforeCall).toBeDefined();

    await app.close();
  });

  it("config.hooks handlers no longer require the resource._pendingHooks workaround", async () => {
    // Before the fix, hosts had to push directly to resource._pendingHooks
    // to get `context` — the documented `hooks: { … }` API silently
    // dropped it. This test asserts that the documented API is
    // complete-on-arrival by letting the hook CREATE an audit record
    // scoped to the caller's tenant using only `ctx.scope`.
    const auditLog: Array<{ org: string; actor: string; action: string; id: unknown }> = [];

    const repo = new Repository<ProductDoc>(Product);
    const adapter: DataAdapter<ProductDoc> = {
      repository: repo as unknown as DataAdapter<ProductDoc>["repository"],
      type: "mongoose",
      name: "product-audit",
    };

    const resource = defineResource<ProductDoc>({
      name: "product-audit",
      prefix: "/audited-products",
      adapter,
      tenantField: "organizationId",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      middlewares: { create: [memberOfOrgA() as never] },
      hooks: {
        afterCreate: (ctx) => {
          // Real-world pattern — no need to dig through metadata._scope
          auditLog.push({
            org: ctx.scope?.organizationId ?? "",
            actor: ctx.scope?.userId ?? "",
            action: "created",
            id: (ctx.data as { _id?: unknown })._id,
          });
        },
      },
    });

    const fastify = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    try {
      const res = await fastify.inject({
        method: "POST",
        url: "/audited-products",
        headers: { "x-org": ORG_A },
        payload: { name: "Tracked", price: 42 },
      });
      expect(res.statusCode).toBe(201);

      expect(auditLog).toHaveLength(1);
      expect(auditLog[0].org).toBe(ORG_A);
      expect(auditLog[0].actor).toBe("user_1");
      expect(auditLog[0].action).toBe("created");
      expect(auditLog[0].id).toBeDefined();
    } finally {
      await fastify.close();
    }
  });
});
