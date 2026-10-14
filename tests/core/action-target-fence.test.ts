/**
 * An id-bound action may act only on a row its caller could `GET`: the action router loads
 * the target through the resource's access control (id + tenant + row policy) and answers
 * 404 otherwise. `target: { scope: 'handler', reason }` hands the check to the handler. A
 * successful action on an `audit: true` resource is audited with the actor from the
 * validated scope.
 */

import { Repository } from "@classytic/mongokit";
import type { DataAdapter } from "@classytic/repo-core/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditPlugin } from "../../src/audit/index.js";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import type { AuditEntry } from "../../src/audit/stores/interface.js";
import { getActionTarget } from "../../src/core/entityHelpers.js";
import { defineResource } from "../../src/index.js";
import { allow, allowPublic, requireAuth } from "../../src/permissions/index.js";

interface Doc {
  _id?: string;
  code?: string;
  organizationId?: string;
  ownerId?: string;
  status: string;
}

const ORG_A = "org_a";
const ORG_B = "org_b";

let mongoServer: MongoMemoryServer;
let Model: mongoose.Model<Doc>;

/** Stamps a MEMBER scope from `x-org` / `x-user` — what an auth adapter does. */
async function memberScope(request: {
  headers: Record<string, string | string[] | undefined>;
  user?: unknown;
  scope?: unknown;
}): Promise<void> {
  const orgId = request.headers["x-org"];
  const userId = request.headers["x-user"];
  if (typeof orgId !== "string" || typeof userId !== "string") return;
  request.user = { id: userId, roles: ["member"] };
  request.scope = { kind: "member", userId, userRoles: ["member"], organizationId: orgId, orgRoles: ["member"] };
}

const handled: string[] = [];
const targets: unknown[] = [];
const entries: AuditEntry[] = [];

async function buildApp(opts: {
  tenantField: string | false;
  ownRowsOnly?: boolean;
  idField?: string;
  lookupFields?: string[];
}): Promise<FastifyInstance> {
  const repo = new Repository<Doc>(Model);
  const adapter: DataAdapter<Doc> = {
    repository: repo as unknown as DataAdapter<Doc>["repository"],
    type: "mongoose",
    name: "fenced",
  };
  const gate = opts.ownRowsOnly
    ? () => allow({ policy: { ownerId: "u1" } })
    : requireAuth();
  const resource = defineResource<Doc>({
    name: "fenced",
    adapter,
    tenantField: opts.tenantField,
    ...(opts.idField ? { idField: opts.idField } : {}),
    ...(opts.lookupFields ? { lookupFields: opts.lookupFields } : {}),
    audit: true,
    permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
    actions: {
      approve: {
        permissions: gate,
        handler: async (id) => {
          handled.push(`approve:${id}`);
          return { id, status: "approved" };
        },
      },
      peek: {
        permissions: gate,
        handler: async (id, _data, req) => {
          targets.push(getActionTarget<Doc>(req));
          return { id };
        },
      },
      relay: {
        permissions: requireAuth(),
        target: { scope: "handler", reason: "the id names a row of another tenant on purpose" },
        handler: async (id, _data, req) => {
          targets.push(getActionTarget(req));
          handled.push(`relay:${id}`);
          return { id };
        },
      },
    },
  });
  const app = Fastify({ logger: { level: process.env.FENCE_LOG ?? "silent" } });
  app.addHook("onRequest", memberScope);
  await app.register(arcCorePlugin);
  await app.register(auditPlugin, {
    enabled: true,
    autoAudit: false,
    customStores: [{ name: "spy", log: async (e: AuditEntry) => void entries.push(e) }],
  });
  await app.register(resource.toPlugin());
  await app.ready();
  return app;
}

const act = (app: FastifyInstance, id: string, action: string, org: string, user = "u1") =>
  app.inject({ method: "POST", url: `/fenceds/${id}/action`, headers: { "x-org": org, "x-user": user }, payload: { action } });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Model = mongoose.model<Doc>(
    "ActionFenceDoc",
    new Schema<Doc>({ code: String, organizationId: String, ownerId: String, status: String }, { timestamps: true }),
  );
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
  handled.length = 0;
  targets.length = 0;
  entries.length = 0;
});

describe("action target fence — tenant", () => {
  it("404s an action on another tenant's row and never runs the handler", async () => {
    const app = await buildApp({ tenantField: "organizationId" });
    const foreign = await Model.create({ organizationId: ORG_B, status: "draft" });
    const res = await act(app, String(foreign._id), "approve", ORG_A);
    expect(res.statusCode).toBe(404);
    expect(handled).toEqual([]);
    await app.close();
  });

  it("runs the action on the caller's own row", async () => {
    const app = await buildApp({ tenantField: "organizationId" });
    const own = await Model.create({ organizationId: ORG_A, status: "draft" });
    const res = await act(app, String(own._id), "approve", ORG_A);
    expect(res.statusCode, res.body).toBe(200);
    expect(handled).toEqual([`approve:${own._id}`]);
    await app.close();
  });

  it("a `target: 'handler'` action reaches its handler for a foreign id", async () => {
    const app = await buildApp({ tenantField: "organizationId" });
    const foreign = await Model.create({ organizationId: ORG_B, status: "draft" });
    const res = await act(app, String(foreign._id), "relay", ORG_A);
    expect(res.statusCode, res.body).toBe(200);
    expect(handled).toEqual([`relay:${foreign._id}`]);
    await app.close();
  });
});

describe("action target — the fenced row reaches the handler", () => {
  it("hands the handler the row the fence read, so it need not load it again", async () => {
    const app = await buildApp({ tenantField: "organizationId" });
    const own = await Model.create({ organizationId: ORG_A, status: "draft" });
    expect((await act(app, String(own._id), "peek", ORG_A)).statusCode).toBe(200);
    expect(targets).toHaveLength(1);
    expect(String((targets[0] as Doc)._id)).toBe(String(own._id));
    expect((targets[0] as Doc).status).toBe("draft");
    await app.close();
  });

  it("a handler-scoped action gets no row: the fence did not read one", async () => {
    const app = await buildApp({ tenantField: "organizationId" });
    const foreign = await Model.create({ organizationId: ORG_B, status: "draft" });
    expect((await act(app, String(foreign._id), "relay", ORG_A)).statusCode).toBe(200);
    expect(targets).toEqual([undefined]);
    await app.close();
  });

  it("an unscoped resource reads nothing, so the handler loads its own row", async () => {
    const app = await buildApp({ tenantField: false });
    const doc = await Model.create({ status: "draft" });
    expect((await act(app, String(doc._id), "peek", ORG_A)).statusCode).toBe(200);
    expect(targets).toEqual([undefined]);
    await app.close();
  });
});

describe("action target fence — row policy", () => {
  it("404s an action on a row outside the gate's policy, even untenanted", async () => {
    const app = await buildApp({ tenantField: false, ownRowsOnly: true });
    const other = await Model.create({ ownerId: "u2", status: "draft" });
    const mine = await Model.create({ ownerId: "u1", status: "draft" });
    const refused = await act(app, String(other._id), "approve", ORG_A);
    expect(refused.statusCode, refused.body).toBe(404);
    expect((await act(app, String(mine._id), "approve", ORG_A)).statusCode).toBe(200);
    expect(handled).toEqual([`approve:${mine._id}`]);
    await app.close();
  });
});

describe("action audit", () => {
  it("records a successful action with the actor and org from the validated scope", async () => {
    const app = await buildApp({ tenantField: "organizationId" });
    const own = await Model.create({ organizationId: ORG_A, status: "draft" });
    expect((await act(app, String(own._id), "approve", ORG_A, "actor-9")).statusCode).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      resource: "fenced",
      documentId: String(own._id),
      action: "custom",
      userId: "actor-9",
      organizationId: ORG_A,
      metadata: { customAction: "approve" },
    });
    await app.close();
  });

  it("writes nothing for a refused action", async () => {
    const app = await buildApp({ tenantField: "organizationId" });
    const foreign = await Model.create({ organizationId: ORG_B, status: "draft" });
    expect((await act(app, String(foreign._id), "approve", ORG_A)).statusCode).toBe(404);
    expect(entries).toEqual([]);
    await app.close();
  });
});

describe("boot", () => {
  it("refuses a tenant-scoped resource whose controller cannot fence its actions", async () => {
    const resource = defineResource({
      name: "unfenceable",
      tenantField: "organizationId",
      disableDefaultRoutes: true,
      actions: { approve: { permissions: requireAuth(), handler: async (id) => ({ id }) } },
    });
    const app = Fastify({ logger: { level: process.env.FENCE_LOG ?? "silent" } });
    await expect(
      (async () => {
        await app.register(resource.toPlugin());
        await app.ready();
      })(),
    ).rejects.toThrow(/cannot authorize an action target/);
    await app.close();
  });

  it("refuses an IMPLICIT-tenant resource whose custom controller cannot fence", async () => {
    const noop = async () => ({ data: {} });
    const adapter: DataAdapter<Doc> = {
      repository: new Repository<Doc>(Model) as unknown as DataAdapter<Doc>["repository"],
      type: "mongoose",
      name: "implicit",
    };
    const resource = defineResource<Doc>({
      name: "implicit",
      adapter,
      controller: { list: noop, get: noop, create: noop, update: noop, delete: noop } as never,
      permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
      actions: { approve: { permissions: requireAuth(), handler: async (id) => ({ id }) } },
    });
    const app = Fastify({ logger: { level: process.env.FENCE_LOG ?? "silent" } });
    await expect(
      (async () => {
        await app.register(resource.toPlugin());
        await app.ready();
      })(),
    ).rejects.toThrow(/organizationId \(default\)/);
    await app.close();
  });

  it("refuses a `target` declaration without a reason", async () => {
    const resource = defineResource({
      name: "unexplained",
      tenantField: false,
      disableDefaultRoutes: true,
      actions: {
        approve: {
          permissions: requireAuth(),
          target: { scope: "handler", reason: " " },
          handler: async (id) => ({ id }),
        },
      },
    });
    const app = Fastify({ logger: { level: process.env.FENCE_LOG ?? "silent" } });
    await expect(
      (async () => {
        await app.register(resource.toPlugin());
        await app.ready();
      })(),
    ).rejects.toThrow(/non-empty `reason`/);
    await app.close();
  });
});

describe("action target fence — business keys resolve exactly as GET /:id does", () => {
  it("a custom primary idField: the action by that key works for its tenant and 404s for another", async () => {
    const app = await buildApp({ tenantField: "organizationId", idField: "code" });
    await Model.create({ code: "RMA-0001", organizationId: ORG_A, status: "draft" });
    expect((await act(app, "RMA-0001", "approve", ORG_A)).statusCode).toBe(200);
    expect((await act(app, "RMA-0001", "approve", ORG_B)).statusCode).toBe(404);
    expect(handled).toEqual(["approve:RMA-0001"]);
    await app.close();
  });

  it("an alternate key beside _id: both keys reach the action and GET, within the tenant only", async () => {
    const app = await buildApp({ tenantField: "organizationId", lookupFields: ["code"] });
    const doc = await Model.create({ code: "RMA-0002", organizationId: ORG_A, status: "draft" });
    const get = (id: string, org: string) =>
      app.inject({ method: "GET", url: `/fenceds/${id}`, headers: { "x-org": org, "x-user": "u1" } });
    const first = await act(app, "RMA-0002", "approve", ORG_A);
    expect(first.statusCode, first.body).toBe(200);
    expect((await act(app, String(doc._id), "approve", ORG_A)).statusCode).toBe(200);
    expect((await get("RMA-0002", ORG_A)).statusCode).toBe(200);
    expect((await act(app, "RMA-0002", "approve", ORG_B)).statusCode).toBe(404);
    expect((await get("RMA-0002", ORG_B)).statusCode).toBe(404);
    await app.close();
  });

  it("without the alternate key, a business number is refused — never resolved unscoped", async () => {
    const app = await buildApp({ tenantField: "organizationId" });
    await Model.create({ code: "RMA-0003", organizationId: ORG_A, status: "draft" });
    const res = await act(app, "RMA-0003", "approve", ORG_A);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(handled).toEqual([]);
    await app.close();
  });
});
