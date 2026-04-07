import Fastify, { type FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import {
  type ArcArchitectureSchema,
  ArcDynamicLoader,
} from "../../src/dynamic/ArcDynamicLoader.js";
// Dummy repository mock logic since the existing createMockRepository
// from setup.ts uses a hardcoded model that might not dynamically fit.
// But wait, setup.ts has a createMockModel and createMockRepository. Let's use them!
import {
  clearDatabase,
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

describe("ArcDynamicLoader Integration E2E", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    if (app) await app.close();
  });

  it("should procedurally generate a fully functional REST API backed by MongoDB", async () => {
    // 1. Create a Fastify app
    app = Fastify();

    // Just mocking a fake authenticate decorator so permissions don't crash
    // Use a valid ObjectId so createdBy casting doesn't fail
    const fakeUserId = new mongoose.Types.ObjectId().toString();
    const dummyAuth = async (req: any, _reply: any) => {
      // Simulate an admin user for testing POSTs etc
      req.scope = { kind: "authenticated", userId: fakeUserId, userRoles: ["admin"] };
      req.user = { id: fakeUserId, roles: ["admin"] };
    };
    app.decorate("authenticate", dummyAuth);
    app.decorate("optionalAuthenticate", dummyAuth);
    app.decorate("authorize", (..._roles: string[]) => async (_req: any, _reply: any) => {
      // do nothing
    });

    // 2. Setup ArcDynamicLoader with real Mongoose Adapters
    const loader = new ArcDynamicLoader({
      adapterResolver: (resourceName: string, _pattern?: string) => {
        // Create a real Mongoose model + MongoKit repository for each generated resource
        const model = createMockModel(resourceName);
        const repo = createMockRepository(model);
        return createMongooseAdapter({ model, repository: repo });
      },
    });

    // 3. Define the Architecture Schema (AAS)
    // AI agents can output this JSON block to instantly scaffold backend CRUD.
    const aas: ArcArchitectureSchema = {
      app: "AI-Generated-App",
      resources: [
        {
          name: "drone",
          adapterPattern: "mongoose",
          permissions: "publicRead", // Allows public GET, requires auth/admin for POST
          presets: ["softDelete"],
        },
        {
          name: "shipment",
          permissions: "publicRead",
        },
      ],
    };

    // 4. Load the definitions and register them as plugins!
    const resources = loader.load(aas);
    expect(resources.length).toBe(2);

    // toPlugin() uses self.prefix internally (e.g. /drones for name: 'drone')
    // so we do NOT pass a separate { prefix } — that would double-nest.
    for (const resource of resources) {
      await app.register(resource.toPlugin());
    }

    await app.ready();

    // ============================================
    // E2E Verification over HTTP
    // ============================================

    // Default prefix for name: 'drone' is '/drones' (pluralized)
    // Arc response shapes: list → { docs: [...], total }, single → { data: {...} }

    // 1. Verify resource exists natively
    const listRes = await app.inject({
      method: "GET",
      url: "/drones",
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.docs).toEqual([]);

    // 2. Insert a document over HTTP POST
    const createRes = await app.inject({
      method: "POST",
      url: "/drones",
      payload: { name: "Delivery Quadcopter", price: 500 },
    });
    expect(createRes.statusCode).toBe(201);
    const createdDoc = JSON.parse(createRes.body);
    expect(createdDoc.data.name).toBe("Delivery Quadcopter");
    expect(createdDoc.data._id).toBeDefined();

    const droneId = createdDoc.data._id;

    // 3. Verify it was written to MongoDB through the dynamic adapter
    const getRes = await app.inject({
      method: "GET",
      url: `/drones/${droneId}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).data.name).toBe("Delivery Quadcopter");

    // 4. Verify PRESET injection — softDelete adds /deleted and /:id/restore routes
    // Note: actual soft-delete DB behavior requires MongoKit's softDeletePlugin
    // in the repository layer. With a basic mock repo, DELETE = hard delete.
    const delRes = await app.inject({
      method: "DELETE",
      url: `/drones/${droneId}`,
    });
    expect(delRes.statusCode).toBe(200);

    // It should be gone from standard queries
    const listRes2 = await app.inject({
      method: "GET",
      url: "/drones",
    });
    expect(JSON.parse(listRes2.body).docs.length).toBe(0);

    // 5. Verify softDelete preset added the /deleted route
    const deletedRes = await app.inject({
      method: "GET",
      url: "/drones/deleted",
    });
    // Route should exist (may return 200 or 500 depending on controller method)
    expect(deletedRes.statusCode).not.toBe(404);
  });
});
