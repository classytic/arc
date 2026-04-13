/**
 * Tests: v2.8.1 action + route improvements
 *
 * Covers the community-reported gaps closed in 2.8.1:
 *
 * 1. Per-action discriminated body schema with required fields enforced at HTTP layer
 * 2. Zod v4 schemas accepted as action schemas (auto-converted to JSON Schema)
 * 3. Full JSON Schema body shape accepted (with explicit `required` array)
 * 4. Legacy field-map shape still works (every field required by default)
 * 5. `mcp: false` / `description` / `annotations` preserved from `routes` through to routes
 * 6. Original `config.routes` retained on ResourceDefinition
 * 7. `config.actions` retained on ResourceDefinition with full metadata
 * 8. OpenAPI generator emits `POST /:id/action` with discriminated body schema
 * 9. Registry exposes actions metadata
 * 10. `buildActionBodySchema` is the single source of truth for runtime + docs
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { buildActionBodySchema } from "../../src/core/createActionRouter.js";
import { defineResource } from "../../src/core/defineResource.js";
import { buildOpenApiSpec } from "../../src/docs/openapi.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic, requireRoles } from "../../src/permissions/index.js";
import type { RegistryEntry } from "../../src/types/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

// ============================================================================
// 1. buildActionBodySchema — pure unit tests (no Fastify)
// ============================================================================

describe("v2.8.1: buildActionBodySchema", () => {
  it("emits oneOf branches with per-action const discriminator", () => {
    const schema = buildActionBodySchema(["approve", "dispatch"], {
      dispatch: { carrier: { type: "string" } },
    });

    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["action"]);
    expect(Array.isArray(schema.oneOf)).toBe(true);

    const branches = schema.oneOf as Array<Record<string, unknown>>;
    expect(branches).toHaveLength(2);

    const approveBranch = branches.find(
      (b) =>
        ((b.properties as Record<string, Record<string, unknown>>).action.const as string) ===
        "approve",
    );
    expect(approveBranch).toBeDefined();
    expect(approveBranch?.required).toEqual(["action"]);

    const dispatchBranch = branches.find(
      (b) =>
        ((b.properties as Record<string, Record<string, unknown>>).action.const as string) ===
        "dispatch",
    );
    expect(dispatchBranch).toBeDefined();
    // Legacy field map: carrier field required by default
    expect(dispatchBranch?.required).toEqual(["action", "carrier"]);
  });

  it("accepts a full JSON Schema with explicit required array", () => {
    const schema = buildActionBodySchema(["cancel"], {
      cancel: {
        type: "object",
        properties: {
          reason: { type: "string", minLength: 10 },
          notify: { type: "boolean" },
        },
        required: ["reason"],
      },
    });

    const cancelBranch = (schema.oneOf as Array<Record<string, unknown>>)[0];
    expect(cancelBranch?.required).toEqual(["action", "reason"]);
    const props = cancelBranch?.properties as Record<string, Record<string, unknown>>;
    expect(props.reason).toMatchObject({ type: "string", minLength: 10 });
    expect(props.notify).toMatchObject({ type: "boolean" });
  });

  it("accepts a Zod v4 schema (auto-converted)", () => {
    const zodSchema = z.object({
      carrier: z.string(),
      trackingId: z.string().optional(),
    });

    const schema = buildActionBodySchema(["dispatch"], {
      dispatch: zodSchema as unknown as Record<string, unknown>,
    });

    const branch = (schema.oneOf as Array<Record<string, unknown>>)[0];
    expect(branch?.required).toContain("action");
    expect(branch?.required).toContain("carrier");
    // trackingId is optional → not in required
    expect(branch?.required).not.toContain("trackingId");
  });

  it("legacy field map with `required: false` sentinel marks field optional", () => {
    const schema = buildActionBodySchema(["ship"], {
      ship: {
        carrier: { type: "string" },
        trackingId: { type: "string", required: false },
      },
    });

    const branch = (schema.oneOf as Array<Record<string, unknown>>)[0];
    expect(branch?.required).toEqual(["action", "carrier"]);
  });

  it("action with no schema gets only `action` required", () => {
    const schema = buildActionBodySchema(["approve"], {});
    const branch = (schema.oneOf as Array<Record<string, unknown>>)[0];
    expect(branch?.required).toEqual(["action"]);
  });

  it("empty action list produces empty oneOf", () => {
    const schema = buildActionBodySchema([], {});
    expect(schema.oneOf).toEqual([]);
  });
});

// ============================================================================
// 2. End-to-end: discriminated schema rejects bad payloads via AJV (HTTP 400)
// ============================================================================

describe("v2.8.1: action validation — end-to-end", () => {
  let app: FastifyInstance;
  let itemId: string;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("ActionsE2E");
    const repo = createMockRepository(Model);
    await Model.create([{ name: "Shipment A", isActive: true }]);

    const resource = defineResource({
      name: "shipment",
      prefix: "/shipments",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "shipment", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        // Bare handler (no schema): only `action` required
        hold: async (id) => ({ id, status: "held" }),

        // Full JSON Schema with explicit required
        dispatch: {
          handler: async (id, data) => ({ id, status: "dispatched", carrier: data.carrier }),
          permissions: allowPublic(),
          schema: {
            type: "object",
            properties: {
              carrier: { type: "string", minLength: 2 },
              trackingId: { type: "string" },
            },
            required: ["carrier"],
          },
        },

        // Zod v4 schema
        receive: {
          handler: async (id, data) => ({ id, status: "received", condition: data.condition }),
          permissions: allowPublic(),
          schema: z.object({
            condition: z.enum(["good", "damaged", "lost"]),
            notes: z.string().optional(),
          }) as unknown as Record<string, unknown>,
        },
      },
      actionPermissions: allowPublic(),
    });

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();

    const list = await app.inject({ method: "GET", url: "/shipments" });
    itemId = JSON.parse(list.body).docs[0]._id;
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("bare handler accepts { action: 'hold' } with nothing else", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/shipments/${itemId}/action`,
      payload: { action: "hold" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("JSON Schema action — missing required field → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/shipments/${itemId}/action`,
      payload: { action: "dispatch" }, // missing carrier
    });
    expect(res.statusCode).toBe(400);
  });

  it("JSON Schema action — too-short value → 400 (minLength enforced)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/shipments/${itemId}/action`,
      payload: { action: "dispatch", carrier: "X" }, // minLength: 2
    });
    expect(res.statusCode).toBe(400);
  });

  it("JSON Schema action — valid payload → 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/shipments/${itemId}/action`,
      payload: { action: "dispatch", carrier: "UPS", trackingId: "T-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.carrier).toBe("UPS");
  });

  it("Zod action — missing required field → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/shipments/${itemId}/action`,
      payload: { action: "receive" }, // missing condition
    });
    expect(res.statusCode).toBe(400);
  });

  it("Zod action — invalid enum value → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/shipments/${itemId}/action`,
      payload: { action: "receive", condition: "excellent" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("Zod action — valid enum value → 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/shipments/${itemId}/action`,
      payload: { action: "receive", condition: "good" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.condition).toBe("good");
  });

  it("unknown action name → 400 (no matching discriminator branch)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/shipments/${itemId}/action`,
      payload: { action: "teleport" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ============================================================================
// 3. Metadata preservation: mcp, description, annotations, retained config
// ============================================================================

describe("v2.8.1: metadata preservation", () => {
  const Model = createMockModel("MetaPreserve");
  const repo = createMockRepository(Model);

  it("routes: mcp: false is preserved on routes after normalization", () => {
    const resource = defineResource({
      name: "widget",
      prefix: "/widgets",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "widget", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      routes: [
        {
          method: "GET",
          path: "/hidden-from-mcp",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ ok: true }),
          raw: true,
          mcp: false,
        },
        {
          method: "GET",
          path: "/with-annotations",
          permissions: allowPublic(),
          handler: async (_req, reply) => reply.send({ ok: true }),
          raw: true,
          mcp: {
            description: "Custom MCP description",
            annotations: { readOnlyHint: true, idempotentHint: true },
          },
        },
      ],
    });

    expect(resource.routes).toHaveLength(2);
    expect(resource.routes[0].mcp).toBe(false);
    expect(resource.routes[1].mcp).toMatchObject({
      description: "Custom MCP description",
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
  });

  it("ResourceDefinition.routes retains original declared shape", () => {
    const routes = [
      {
        method: "GET" as const,
        path: "/stats",
        permissions: allowPublic(),
        handler: async (_req: unknown, reply: { send: (x: unknown) => void }) =>
          reply.send({ ok: true }),
        raw: true,
        description: "Stats endpoint",
        tags: ["analytics"],
        mcp: false as const,
      },
    ];

    const resource = defineResource({
      name: "gadget",
      prefix: "/gadgets",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "gadget", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      routes,
    });

    // Original routes array is retained
    expect(resource.routes).toBeDefined();
    expect(resource.routes?.length).toBe(1);
    expect(resource.routes?.[0].description).toBe("Stats endpoint");
    expect(resource.routes?.[0].tags).toEqual(["analytics"]);
    expect(resource.routes?.[0].mcp).toBe(false);
  });

  it("ResourceDefinition.actions retains full ActionDefinition metadata", () => {
    const resource = defineResource({
      name: "invoice",
      prefix: "/invoices",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "invoice", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        finalize: {
          handler: async (id) => ({ id, status: "final" }),
          permissions: requireRoles(["accountant"]),
          schema: { amount: { type: "number" } },
          description: "Finalize and lock the invoice",
          mcp: false,
        },
      },
    });

    const action = resource.actions?.finalize;
    expect(action).toBeDefined();
    // Bare-function check — must be an object to carry metadata
    expect(typeof action).toBe("object");
    if (typeof action === "object" && action) {
      expect(action.description).toBe("Finalize and lock the invoice");
      expect(action.mcp).toBe(false);
      expect(action.schema).toBeDefined();
    }
  });
});

// ============================================================================
// 4. OpenAPI generation: POST /:id/action emitted with discriminated schema
// ============================================================================

describe("v2.8.1: OpenAPI action path generation", () => {
  it("emits POST /{id}/action with oneOf body schema from resource.actions", () => {
    const fakeResource: RegistryEntry = {
      name: "order",
      prefix: "/orders",
      presets: [],
      permissions: {},
      routes: [],
      routes: [],
      actions: [
        {
          name: "approve",
          description: "Approve the order",
          permissions: allowPublic(),
        },
        {
          name: "dispatch",
          description: "Dispatch the order to shipping",
          schema: {
            type: "object",
            properties: { carrier: { type: "string" } },
            required: ["carrier"],
          },
          permissions: allowPublic(),
        },
      ],
      plugin: () => {},
      disableDefaultRoutes: true,
      disabledRoutes: [],
    };

    const spec = buildOpenApiSpec([fakeResource], { title: "Test", version: "1.0.0" });

    const actionPath = spec.paths["/orders/{id}/action"];
    expect(actionPath).toBeDefined();
    expect(actionPath?.post).toBeDefined();

    const op = actionPath?.post;
    // Path param id
    expect(op?.parameters?.some((p) => p.name === "id")).toBe(true);

    // Request body uses the discriminated oneOf schema
    const bodySchema = op?.requestBody?.content?.["application/json"]?.schema as Record<
      string,
      unknown
    >;
    expect(bodySchema?.type).toBe("object");
    expect(bodySchema?.required).toEqual(["action"]);
    expect(Array.isArray(bodySchema?.oneOf)).toBe(true);
    expect((bodySchema?.oneOf as unknown[]).length).toBe(2);

    // Description lists each action
    expect(op?.description).toContain("approve");
    expect(op?.description).toContain("dispatch");
    expect(op?.description).toContain("Approve the order");
  });

  it("does not emit action path when resource has no actions", () => {
    const fakeResource: RegistryEntry = {
      name: "plain",
      prefix: "/plains",
      presets: [],
      permissions: {},
      routes: [],
      routes: [],
      plugin: () => {},
      disableDefaultRoutes: true,
      disabledRoutes: [],
    };

    const spec = buildOpenApiSpec([fakeResource], { title: "Test", version: "1.0.0" });

    expect(spec.paths["/plains/{id}/action"]).toBeUndefined();
  });
});
