/**
 * Tests for resource-root actions (v2.15.5).
 *
 * Locks in the fix for the OpenAI-team report: actions like `propose`,
 * `search`, or `bulk` that don't operate on an existing entity used to
 * be forced under `POST /<prefix>/:id/action` — every host had to swallow
 * a meaningless `_id` and the auto-generated MCP tool advertised an `id`
 * field agents had no value for.
 *
 * Contract this file locks in:
 *  - `actions: { propose: { id: false, handler: ... } }` mounts the
 *    action at `POST /<prefix>/action` (no `:id`).
 *  - The handler receives `id: ""` as the first argument (signature
 *    parity with id-bound actions).
 *  - Id-bound actions on the same resource still mount at
 *    `POST /<prefix>/:id/action`.
 *  - Calling an id-bound action via the id-less mount (or vice versa)
 *    returns `arc.invalid_action` 400 with a "mounted at the other path"
 *    hint pointing the caller at the right URL.
 *  - MCP tool for an id-less action drops `id` from its input schema.
 *  - Registry's route enumeration emits BOTH mount points when both
 *    have at least one action.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineResource } from "../../src/core/defineResource.js";
import { resourceToTools } from "../../src/integrations/mcp/resourceToTools.js";
import { allowPublic } from "../../src/permissions/index.js";
import { errorHandlerPlugin } from "../../src/plugins/errorHandler.js";
import { ResourceRegistry } from "../../src/registry/ResourceRegistry.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

interface ActionResult {
  id: string;
  data: Record<string, unknown>;
}

async function buildApp(name: string): Promise<FastifyInstance> {
  const Model = createMockModel(`ActionRootMount_${name}`);
  const repo = createMockRepository(Model);
  const [doc] = await Model.create([{ name: "fixture" }]);
  const docId = String(doc._id);

  const resource = defineResource({
    name: `actionroot-${name}`,
    prefix: `/actionroot-${name}`,
    adapter: createMongooseAdapter({ model: Model, repository: repo as never }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    actions: {
      // Id-bound action (legacy default). Mounts at `/:id/action`.
      recordPayment: {
        handler: async (id, data) => ({ id, data }) satisfies ActionResult,
        permissions: allowPublic(),
        schema: z.object({ amount: z.number() }) as unknown as Record<string, unknown>,
      },
      // Id-less action (resource root). Mounts at `/action`.
      propose: {
        handler: async (id, data) => ({ id, data }) satisfies ActionResult,
        permissions: allowPublic(),
        id: false,
        schema: z.object({ brief: z.string() }) as unknown as Record<string, unknown>,
      },
      // Another id-less to verify multi-action mounts share one URL.
      search: {
        handler: async (id, data) => ({ id, data }) satisfies ActionResult,
        permissions: allowPublic(),
        id: false,
        schema: z.object({ q: z.string() }) as unknown as Record<string, unknown>,
      },
    },
  });

  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(resource.toPlugin());
  await app.ready();
  (app as unknown as { docId: string }).docId = docId;
  return app;
}

describe("resource-root actions (id: false) — HTTP routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("id-less action mounts at POST /<prefix>/action and runs", async () => {
    app = await buildApp("ok");

    const res = await app.inject({
      method: "POST",
      url: "/actionroot-ok/action",
      headers: { "content-type": "application/json" },
      payload: { action: "propose", brief: "draft a new entity" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ActionResult;
    // Handler signature parity: id is "" for id-less actions; data is the
    // body sans the `action` discriminator.
    expect(body.id).toBe("");
    expect(body.data).toEqual({ brief: "draft a new entity" });
  });

  it("id-bound action still mounts at POST /<prefix>/:id/action and receives id", async () => {
    app = await buildApp("idbound");
    const docId = (app as unknown as { docId: string }).docId;

    const res = await app.inject({
      method: "POST",
      url: `/actionroot-idbound/${docId}/action`,
      headers: { "content-type": "application/json" },
      payload: { action: "recordPayment", amount: 100 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ActionResult;
    expect(body.id).toBe(docId);
    expect(body.data).toEqual({ amount: 100 });
  });

  it("id-bound action via id-less URL returns the 'wrong mount' hint", async () => {
    // The mentora repro's symptom: calling a propose-style action at
    // `/:id/action` (or an id-bound action at `/action`) used to surface
    // "Unknown action" without telling the caller WHERE it lives.
    app = await buildApp("wrongmount");

    const res = await app.inject({
      method: "POST",
      url: "/actionroot-wrongmount/action",
      headers: { "content-type": "application/json" },
      payload: { action: "recordPayment", amount: 100 },
    });

    expect(res.statusCode).toBe(400);
    const err = JSON.parse(res.body) as {
      code?: string;
      message?: string;
      meta?: { mountedAt?: string };
    };
    expect(err.code).toBe("arc.invalid_action");
    expect(err.message).toContain("recordPayment");
    expect(err.message).toContain("/:id/action");
    expect(err.meta?.mountedAt).toBe("/:id/action");
  });

  it("id-less action via id-bound URL returns the 'wrong mount' hint", async () => {
    app = await buildApp("wrongmount2");
    const docId = (app as unknown as { docId: string }).docId;

    const res = await app.inject({
      method: "POST",
      url: `/actionroot-wrongmount2/${docId}/action`,
      headers: { "content-type": "application/json" },
      payload: { action: "propose", brief: "trying wrong url" },
    });

    expect(res.statusCode).toBe(400);
    const err = JSON.parse(res.body) as {
      code?: string;
      message?: string;
      meta?: { mountedAt?: string };
    };
    expect(err.code).toBe("arc.invalid_action");
    expect(err.message).toContain("propose");
    expect(err.message).toContain("/action");
    expect(err.meta?.mountedAt).toBe("/action");
  });

  it("validation errors stay scoped to the matching id-less action", async () => {
    // Mentora repro on the id-less mount: posting `propose` without the
    // required `brief` field should report `brief` (propose's own
    // schema), never `q` (search's). The per-mount oneOf filtering is
    // what makes this hold.
    app = await buildApp("scoped");

    const res = await app.inject({
      method: "POST",
      url: "/actionroot-scoped/action",
      headers: { "content-type": "application/json" },
      payload: { action: "propose" }, // missing brief
    });

    expect(res.statusCode).toBe(400);
    const err = JSON.parse(res.body) as {
      code?: string;
      meta?: { action?: string };
      details?: Array<{ path?: string; message?: string }>;
    };
    expect(err.code).toBe("arc.validation_error");
    expect(err.meta?.action).toBe("propose");
    const detailFields = (err.details ?? []).map((d) => d.path).filter(Boolean);
    const detailMessages = (err.details ?? []).map((d) => d.message ?? "").join(" ");
    // `brief` must appear (propose's own required field).
    expect(detailMessages).toContain("brief");
    // Other actions' required fields must NOT leak. `\b` word-boundary
    // avoids matching `q` as a substring of `required`.
    expect(detailFields).not.toContain("q"); // search.q
    expect(detailFields).not.toContain("amount"); // recordPayment.amount
    expect(detailMessages).not.toMatch(/'q'/);
    expect(detailMessages).not.toMatch(/'amount'/);
  });
});

describe("resource-root actions — MCP tool surface", () => {
  it("drops `id` from the MCP tool input schema for id-less actions", async () => {
    const Model = createMockModel("ActionRootMcp");
    const repo = createMockRepository(Model);
    const resource = defineResource({
      name: "actionroot-mcp",
      prefix: "/actionroot-mcp",
      adapter: createMongooseAdapter({ model: Model, repository: repo as never }),
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      actions: {
        recordPayment: {
          handler: async (id, data) => ({ id, data }),
          permissions: allowPublic(),
          schema: z.object({ amount: z.number() }) as unknown as Record<string, unknown>,
        },
        propose: {
          handler: async (id, data) => ({ id, data }),
          permissions: allowPublic(),
          id: false,
          schema: z.object({ brief: z.string() }) as unknown as Record<string, unknown>,
        },
      },
    });

    const tools = resourceToTools(resource);
    const record = tools.find((t) => t.name === "recordPayment_actionroot-mcp");
    const propose = tools.find((t) => t.name === "propose_actionroot-mcp");
    expect(record).toBeDefined();
    expect(propose).toBeDefined();
    // Id-bound action: `id` is in the input shape.
    expect(record?.inputSchema).toHaveProperty("id");
    expect(record?.inputSchema).toHaveProperty("amount");
    // Id-less action: `id` is NOT advertised — agents pass only the
    // schema-declared fields.
    expect(propose?.inputSchema).not.toHaveProperty("id");
    expect(propose?.inputSchema).toHaveProperty("brief");
  });
});

describe("resource-root actions — registry route enumeration", () => {
  it("emits both POST /:id/action and POST /action when both mounts have actions", () => {
    const Model = createMockModel("ActionRootRegistry");
    const repo = createMockRepository(Model);
    const resource = defineResource({
      name: "actionroot-registry",
      prefix: "/actionroot-registry",
      adapter: createMongooseAdapter({ model: Model, repository: repo as never }),
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      actions: {
        approve: {
          handler: async (id) => ({ id }),
          permissions: allowPublic(),
        },
        propose: {
          handler: async () => ({ proposed: true }),
          permissions: allowPublic(),
          id: false,
        },
      },
    });

    const registry = new ResourceRegistry();
    registry.register(resource);
    const entry = registry.get("actionroot-registry");
    expect(entry).toBeDefined();
    const routes = registry.enumerateRoutes(entry as NonNullable<typeof entry>);

    const actionRoutes = routes.filter((r) => r.operation === "action").map((r) => r.path);
    expect(actionRoutes).toContain("/actionroot-registry/:id/action");
    expect(actionRoutes).toContain("/actionroot-registry/action");
    expect(actionRoutes).toHaveLength(2);
  });

  it("emits only POST /:id/action when no actions opt out (backwards-compat default)", () => {
    const Model = createMockModel("ActionRootRegistryLegacy");
    const repo = createMockRepository(Model);
    const resource = defineResource({
      name: "actionroot-legacy",
      prefix: "/actionroot-legacy",
      adapter: createMongooseAdapter({ model: Model, repository: repo as never }),
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      actions: {
        approve: { handler: async (id) => ({ id }), permissions: allowPublic() },
        reject: { handler: async (id) => ({ id }), permissions: allowPublic() },
      },
    });

    const registry = new ResourceRegistry();
    registry.register(resource);
    const entry = registry.get("actionroot-legacy");
    const routes = registry.enumerateRoutes(entry as NonNullable<typeof entry>);

    const actionRoutes = routes.filter((r) => r.operation === "action").map((r) => r.path);
    expect(actionRoutes).toEqual(["/actionroot-legacy/:id/action"]);
  });
});
