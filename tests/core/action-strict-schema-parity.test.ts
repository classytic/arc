/**
 * `additionalProperties: false` parity — HTTP + MCP regression tests
 *
 * [createActionRouter.ts](../../src/core/createActionRouter.ts) documents
 * strict-mode validation as an opt-in: authors who declare
 * `additionalProperties: false` in their action `schema` should get unknown
 * fields rejected. Before v2.11.x the normalization pass dropped the flag —
 * the escape hatch silently no-opped on HTTP, and MCP never honored it at
 * all (the flat Zod shape can't express `.strict()` natively).
 *
 * After the schema IR refactor ([../../src/core/schemaIR.ts]):
 *   - HTTP: AJV rejects unknown fields at the validation layer (preValidation)
 *   - MCP:  the action tool handler rejects unknown fields at request time
 *
 * These tests lock both behaviours so the "documented → honored" invariant
 * doesn't silently drift again.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { resourceToTools } from "../../src/integrations/mcp/resourceToTools.js";
import type { ToolContext } from "../../src/integrations/mcp/types.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

// ============================================================================
// Shared — build a resource with a strict-mode action
// ============================================================================

function makeStrictActionResource(opts: {
  name: string;
  prefix: string;
  modelName: string;
  schema: Record<string, unknown>;
}) {
  const Model = createMockModel(opts.modelName);
  const repo = createMockRepository(Model);

  const resource = defineResource({
    name: opts.name,
    prefix: opts.prefix,
    adapter: createMongooseAdapter(Model, repo),
    controller: new BaseController(repo, { resourceName: opts.name, tenantField: false }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    actions: {
      charge: {
        handler: async (id, data) => ({ id, amount: data.amount }),
        permissions: allowPublic(),
        schema: opts.schema,
      },
    },
    actionPermissions: allowPublic(),
  });

  return { resource, Model };
}

function toolCtx(session: Record<string, unknown> | null): ToolContext {
  return { session: session as ToolContext["session"] } as ToolContext;
}

// ============================================================================
// 1. HTTP — AJV rejects unknown fields via preValidation
// ============================================================================

describe("Action strict schema (additionalProperties: false) — HTTP / AJV", () => {
  let app: FastifyInstance;
  let itemId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const { resource, Model } = makeStrictActionResource({
      name: "strictaction",
      prefix: "/strictaction",
      modelName: "StrictActionItem",
      schema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        additionalProperties: false,
      },
    });

    const [u] = await Model.create([{ name: "strict-test", isActive: true }]);
    itemId = String(u._id);

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("accepts a payload with only declared fields (valid)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/strictaction/${itemId}/action`,
      payload: { action: "charge", amount: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).amount).toBe(100);
  });

  it("rejects a payload with an unknown field (the core regression fix)", async () => {
    // Before v2.11.x: this passed validation because `additionalProperties: false`
    // was dropped during schema normalization — AJV never saw the flag.
    // After: AJV rejects at preValidation, handler never runs.
    const res = await app.inject({
      method: "POST",
      url: `/strictaction/${itemId}/action`,
      payload: { action: "charge", amount: 100, unexpected: "nope" },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ============================================================================
// 2. HTTP — z.strictObject() Zod schemas also reject unknown fields
// ============================================================================

describe("Action strict schema (z.strictObject) — HTTP / AJV", () => {
  let app: FastifyInstance;
  let itemId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const { resource, Model } = makeStrictActionResource({
      name: "zodstrict",
      prefix: "/zodstrict",
      modelName: "ZodStrictItem",
      // z.strictObject() compiles to JSON Schema with additionalProperties: false
      schema: z.strictObject({ amount: z.number() }) as unknown as Record<string, unknown>,
    });

    const [u] = await Model.create([{ name: "zod-strict-test", isActive: true }]);
    itemId = String(u._id);

    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("z.strictObject threads strict mode through to AJV (rejects unknown field)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/zodstrict/${itemId}/action`,
      payload: { action: "charge", amount: 100, extra: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ============================================================================
// 3. MCP — tool handler rejects unknown fields (parity with HTTP)
// ============================================================================

describe("Action strict schema (additionalProperties: false) — MCP parity", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("MCP tool rejects input with unknown fields when schema declares strict", async () => {
    const { resource } = makeStrictActionResource({
      name: "mcpstrict",
      prefix: "/mcpstrict",
      modelName: "McpStrictItem",
      schema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        additionalProperties: false,
      },
    });

    const tools = resourceToTools(resource);
    const chargeTool = tools.find((t) => t.name.includes("charge"));
    expect(chargeTool).toBeDefined();

    // Valid input — passes through cleanly
    const ok = await chargeTool?.handler({ id: "any-id", amount: 100 }, toolCtx({ userId: "u1" }));
    expect(ok?.isError).not.toBe(true);

    // Invalid input — unknown property. MCP's flat-shape inputSchema can't
    // express `.strict()` natively, so the action handler enforces it at
    // request time by comparing against the declared property set.
    const bad = await chargeTool?.handler(
      { id: "any-id", amount: 100, unexpected: "boom" },
      toolCtx({ userId: "u1" }),
    );
    expect(bad?.isError).toBe(true);
    const text = bad?.content?.[0]?.text as string;
    expect(text).toContain("Unknown properties not allowed");
    expect(text).toContain("unexpected");
  });

  it("MCP tool allows unknown fields when schema does NOT declare strict", async () => {
    const { resource } = makeStrictActionResource({
      name: "mcppermissive",
      prefix: "/mcppermissive",
      modelName: "McpPermissiveItem",
      schema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        // No additionalProperties flag — arc actions are permissive by default
      },
    });

    const tools = resourceToTools(resource);
    const chargeTool = tools.find((t) => t.name.includes("charge"));

    const ok = await chargeTool?.handler(
      { id: "any-id", amount: 100, note: "extra field, no error" },
      toolCtx({ userId: "u1" }),
    );
    expect(ok?.isError).not.toBe(true);
  });

  it("MCP tool allows `id` even though it's not in the action schema (path param carveout)", async () => {
    // `id` is always added to the input shape separately (path param) and
    // must never trigger the unknown-property guard. This regression test
    // pins that contract.
    const { resource } = makeStrictActionResource({
      name: "mcpidcarveout",
      prefix: "/mcpidcarveout",
      modelName: "McpIdCarveoutItem",
      schema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        additionalProperties: false,
      },
    });

    const tools = resourceToTools(resource);
    const chargeTool = tools.find((t) => t.name.includes("charge"));

    const ok = await chargeTool?.handler(
      { id: "order-42", amount: 100 },
      toolCtx({ userId: "u1" }),
    );
    expect(ok?.isError).not.toBe(true);
  });
});
