/**
 * CRUD route-table regression
 *
 * Locks in the v2.11.x refactor that collapsed the five hand-written CRUD
 * route blocks in createCrudRouter.ts into a single data-driven table. The
 * refactor preserves behavior; these tests catch drift if a future change
 * accidentally:
 *
 *   - skips the auth/permission chain for one op
 *   - drops a per-op middleware slot (middlewares.list/.get/.create/.update/.delete)
 *   - misroutes `/:id` params (e.g. list registering on `/:id` or get on `/`)
 *   - breaks updateMethod: "both" (should register both PUT and PATCH)
 *   - breaks disabledRoutes (should make the disabled op return 404)
 *
 * Test strategy: mount a resource with per-op sentinel middlewares that push
 * into a shared array. Inject requests against each default CRUD URL and
 * verify (a) the expected status came back, and (b) only the matching op's
 * sentinel fired. If the route table ever wires an op to the wrong handler
 * or drops a middleware slot, the sentinel for that op won't fire (or the
 * wrong one will) and these tests fail.
 */

import { methodRegistryPlugin, mongoOperationsPlugin, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyReply, FastifyRequest } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

interface IItem {
  name: string;
  status: string;
}

const ItemSchema = new Schema<IItem>(
  { name: { type: String, required: true }, status: { type: String, default: "active" } },
  { timestamps: true },
);

let mongoServer: MongoMemoryServer;
let ItemModel: Model<IItem>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ItemModel = mongoose.models.CrudTableItem || mongoose.model<IItem>("CrudTableItem", ItemSchema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ItemModel.deleteMany({});
});

/** Build a resource + app with per-op sentinel middlewares recording which op fired. */
async function buildApp(opts?: {
  updateMethod?: "PUT" | "PATCH" | "both";
  disabledRoutes?: Array<"list" | "get" | "create" | "update" | "delete">;
}) {
  const repo = new Repository<IItem>(ItemModel, [methodRegistryPlugin(), mongoOperationsPlugin()]);
  const fired: string[] = [];
  const sentinel = (op: string) => async (_req: FastifyRequest, _reply: FastifyReply) => {
    fired.push(op);
  };

  const resource = defineResource<IItem>({
    name: "item",
    adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
    tenantField: false,
    controller: new BaseController(repo, { resourceName: "item", tenantField: false }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    middlewares: {
      list: [sentinel("list")],
      get: [sentinel("get")],
      create: [sentinel("create")],
      update: [sentinel("update")],
      delete: [sentinel("delete")],
    },
    ...(opts?.updateMethod ? { updateMethod: opts.updateMethod } : {}),
    ...(opts?.disabledRoutes ? { disabledRoutes: opts.disabledRoutes } : {}),
  });

  const app = await createApp({
    preset: "development",
    auth: false,
    logger: false,
    helmet: false,
    cors: false,
    rateLimit: false,
    underPressure: false,
    plugins: async (fastify) => {
      await fastify.register(resource.toPlugin());
    },
  });
  await app.ready();

  return { app, fired };
}

describe("CRUD route-table regression", () => {
  it("mounts all five default routes at the correct method+URL", async () => {
    const { app, fired } = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/items",
        payload: { name: "Alpha" },
      });
      expect(created.statusCode).toBe(201);
      const createdId = (created.json() as { _id: string })._id;

      const list = await app.inject({ method: "GET", url: "/items" });
      expect(list.statusCode).toBe(200);

      const get = await app.inject({ method: "GET", url: `/items/${createdId}` });
      expect(get.statusCode).toBe(200);

      const updated = await app.inject({
        method: "PATCH",
        url: `/items/${createdId}`,
        payload: { status: "updated" },
      });
      expect(updated.statusCode).toBe(200);

      const deleted = await app.inject({ method: "DELETE", url: `/items/${createdId}` });
      expect(deleted.statusCode).toBe(200);

      // Each default route fired its own per-op sentinel middleware exactly once —
      // proves middlewares[op] is still wired to the matching route after the
      // table-driven rewrite.
      expect(fired).toEqual(["create", "list", "get", "update", "delete"]);
    } finally {
      await app.close();
    }
  });

  it("GET / and GET /:id are separate routes (list vs get routing preserved)", async () => {
    // If the table accidentally swapped list/get URLs or dropped the :id param,
    // GET /items/<id> would fall through to the list handler (returning an array)
    // or 404. This test pins the distinction.
    const { app } = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/items",
        payload: { name: "First" },
      });
      const id = (created.json() as { _id: string })._id;

      const list = await app.inject({ method: "GET", url: "/items" });
      expect(list.statusCode).toBe(200);

      const single = await app.inject({ method: "GET", url: `/items/${id}` });
      expect(single.statusCode).toBe(200);
      // The key routing invariant: GET /:id MUST resolve to the get handler
      // (returns the specific document we asked for by id), not the list
      // handler. If the table swapped URLs, this would return a list.
      const singleBody = single.json() as { _id: string; name: string };
      expect(singleBody._id).toBe(id);
      expect(singleBody.name).toBe("First");
    } finally {
      await app.close();
    }
  });

  it("updateMethod: 'both' registers BOTH PUT and PATCH at /:id", async () => {
    const { app, fired } = await buildApp({ updateMethod: "both" });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/items",
        payload: { name: "Bravo" },
      });
      const id = (created.json() as { _id: string })._id;

      const patched = await app.inject({
        method: "PATCH",
        url: `/items/${id}`,
        payload: { status: "patched" },
      });
      expect(patched.statusCode).toBe(200);

      const replaced = await app.inject({
        method: "PUT",
        url: `/items/${id}`,
        payload: { name: "Bravo", status: "replaced" },
      });
      expect(replaced.statusCode).toBe(200);

      // Both update variants must fire the `update` sentinel.
      const updateFires = fired.filter((f) => f === "update");
      expect(updateFires).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("disabledRoutes skips only the listed ops, leaves others wired", async () => {
    // Regression: the table iterates and `continue`s on disabled ops. If a
    // refactor ever broke the skip (e.g. registering disabled routes anyway)
    // or over-skipped (dropping a non-disabled op), this test catches it.
    const { app, fired } = await buildApp({ disabledRoutes: ["delete", "list"] });
    try {
      // Disabled routes → 404
      const listDisabled = await app.inject({ method: "GET", url: "/items" });
      expect(listDisabled.statusCode).toBe(404);

      // Non-disabled routes still wired
      const created = await app.inject({
        method: "POST",
        url: "/items",
        payload: { name: "Charlie" },
      });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { _id: string })._id;

      const got = await app.inject({ method: "GET", url: `/items/${id}` });
      expect(got.statusCode).toBe(200);

      // delete disabled
      const del = await app.inject({ method: "DELETE", url: `/items/${id}` });
      expect(del.statusCode).toBe(404);

      // list sentinel never fires; delete sentinel never fires; others do
      expect(fired).toContain("create");
      expect(fired).toContain("get");
      expect(fired).not.toContain("list");
      expect(fired).not.toContain("delete");
    } finally {
      await app.close();
    }
  });

  it("auth middleware fires per-op (401 on protected op, 200 on public op in same resource)", async () => {
    // Mixed-auth resource: list is public, create requires auth. This
    // exercises `buildAuthMiddleware` being built per-op inside the table
    // loop. Regression guard against a refactor that hoists the auth
    // middleware out of the loop and applies one setting to all ops.
    const repo = new Repository<IItem>(ItemModel, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
    ]);

    const resource = defineResource<IItem>({
      name: "item",
      adapter: createMongooseAdapter({ model: ItemModel, repository: repo }),
      tenantField: false,
      controller: new BaseController(repo, { resourceName: "item", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        // Non-public permission — will require auth via fastify.authenticate
        create: async ({ user }) => ({
          granted: Boolean(user),
          reason: "requires login",
        }),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const app = await createApp({
      preset: "development",
      auth: false,
      logger: false,
      helmet: false,
      cors: false,
      rateLimit: false,
      underPressure: false,
      plugins: async (fastify) => {
        // Stub authenticate so the auth middleware path is exercised even
        // though we run without a real auth plugin. buildAuthMiddleware picks
        // this up from fastify.authenticate on protected routes.
        fastify.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
          if (!req.headers.authorization) {
            reply.code(401).send({ success: false, error: "no token" });
            return;
          }
          (req as unknown as { user: { id: string } }).user = { id: "u1" };
        });
        fastify.decorate(
          "optionalAuthenticate",
          async (req: FastifyRequest, _reply: FastifyReply) => {
            if (req.headers.authorization) {
              (req as unknown as { user: { id: string } }).user = { id: "u1" };
            }
          },
        );
        await fastify.register(resource.toPlugin());
      },
    });
    await app.ready();

    try {
      // Public list: no auth header → still 200
      const publicList = await app.inject({ method: "GET", url: "/items" });
      expect(publicList.statusCode).toBe(200);

      // Protected create: no auth header → 401 (from stubbed authenticate)
      const unauthorized = await app.inject({
        method: "POST",
        url: "/items",
        payload: { name: "X" },
      });
      expect(unauthorized.statusCode).toBe(401);

      // Protected create: with auth header → 201
      const authorized = await app.inject({
        method: "POST",
        url: "/items",
        payload: { name: "X" },
        headers: { authorization: "Bearer test" },
      });
      expect(authorized.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
