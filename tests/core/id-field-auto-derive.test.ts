/**
 * idField auto-derive — end-to-end with REAL Mongoose + MongoKit
 *
 * Verifies that when a MongoKit Repository is created with `{ idField: 'id' }`,
 * the user does NOT need to ALSO set `idField` on `defineResource()`. Arc
 * auto-derives the resource idField from `adapter.repository.idField`, and
 * threads it through:
 *
 *   1. AJV params schema strip (UUIDs/slugs not rejected as ObjectId)
 *   2. BaseController.idField (lookup pass-through, no slug→_id translation)
 *   3. ResourceDefinition.idField (introspection / OpenAPI)
 *
 * This is the core DX win: configure idField in ONE place (the repo) and
 * everything just works.
 */

import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Model, Schema } from "mongoose";
import qs from "qs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { arcCorePlugin } from "../../src/core/arcCorePlugin.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";

interface IChat {
  id: string;
  title: string;
  organizationId?: string;
}

let mongoServer: MongoMemoryServer;
let ChatModel: Model<IChat>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const schema = new Schema<IChat>(
    {
      id: { type: String, required: true, unique: true, index: true },
      title: { type: String, required: true },
      organizationId: { type: String },
    },
    { timestamps: true },
  );
  ChatModel = mongoose.models.AutoDeriveChat || mongoose.model<IChat>("AutoDeriveChat", schema);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ChatModel.deleteMany({});
});

async function buildApp(): Promise<FastifyInstance> {
  return Fastify({
    logger: false,
    routerOptions: { querystringParser: (s: string) => qs.parse(s) },
    ajv: { customOptions: { coerceTypes: true, useDefaults: true } },
  });
}

describe("idField auto-derive: repo configures it once, everything else follows", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Repository declares idField — this is the ONLY place idField is set.
    const repo = new Repository<IChat>(ChatModel, [], {}, { idField: "id" });

    // Note: NO `idField: 'id'` on defineResource. It should auto-derive from repo.
    const chatResource = defineResource<IChat>({
      name: "chat",
      // biome-ignore lint: generic
      adapter: createMongooseAdapter({ model: ChatModel, repository: repo }),
      queryParser: new QueryParser({ allowedFilterFields: ["id", "title"] }),
      tenantField: false,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Sanity: the resource definition picked up idField from the repo
    expect(chatResource.idField).toBe("id");

    app = await buildApp();
    await app.register(arcCorePlugin);
    await app.register(chatResource.toPlugin());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const UUID = "550e8400-e29b-41d4-a716-446655440000";

  it("GET /chats/:id with UUID — AJV passes (no ObjectId pattern), repo finds doc", async () => {
    await ChatModel.create({ id: UUID, title: "Hello" });

    const res = await app.inject({ method: "GET", url: `/chats/${UUID}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(UUID);
    expect(body.title).toBe("Hello");
  });

  it("PATCH /chats/:id with UUID — auto-derived idField pass-through to repo", async () => {
    await ChatModel.create({ id: UUID, title: "Old" });

    const res = await app.inject({
      method: "PATCH",
      url: `/chats/${UUID}`,
      payload: { title: "New" },
    });

    expect(res.statusCode).toBe(200);
    const doc = await ChatModel.findOne({ id: UUID }).lean();
    expect(doc?.title).toBe("New");
  });

  it("DELETE /chats/:id with UUID — auto-derived idField pass-through to repo", async () => {
    await ChatModel.create({ id: UUID, title: "Doomed" });

    const res = await app.inject({ method: "DELETE", url: `/chats/${UUID}` });

    expect(res.statusCode).toBe(200);
    expect(await ChatModel.findOne({ id: UUID })).toBeNull();
  });

  it("POST /chats with UUID payload — create works without idField on resource", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chats",
      payload: { id: UUID, title: "Created via POST" },
    });

    expect(res.statusCode).toBe(201);
    const doc = await ChatModel.findOne({ id: UUID }).lean();
    expect(doc?.title).toBe("Created via POST");
  });

  it("GET /chats/:id returns 404 for unknown UUID (not 500 from AJV ObjectId pattern)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/chats/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("idField auto-derive: explicit override on the resource takes precedence", () => {
  // Configuration sanity test — does NOT exercise the runtime, only verifies
  // that `defineResource({ idField })` overrides the auto-derived value from
  // the repo. Whether that override actually *works* at runtime depends on
  // the repo's lookup methods supporting that field — which is the user's
  // responsibility, not Arc's.
  //
  // Rule: the repo and the resource SHOULD agree on idField. If you want
  // ObjectId-keyed routes, configure the repo with `idField: '_id'` (or omit
  // it — that's the default). If you want UUID/slug-keyed routes, configure
  // the repo with `{ idField: 'id' }` (or your field of choice). Arc auto-
  // derives so you only need to set it in one place; explicit override exists
  // for cases like "I have a custom QueryParser layer" or "I want different
  // route names".
  it("explicit idField on resource overrides repo's idField in the resource definition", () => {
    const repo = new Repository<IChat>(ChatModel, [], {}, { idField: "id" });

    const chatResource = defineResource<IChat>({
      name: "chat-explicit",
      // biome-ignore lint: generic
      adapter: createMongooseAdapter({ model: ChatModel, repository: repo }),
      queryParser: new QueryParser({ allowedFilterFields: ["id"] }),
      tenantField: false,
      idField: "_id", // explicit
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    // Resource definition reflects the explicit override
    expect(chatResource.idField).toBe("_id");
  });
});
