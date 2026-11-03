/**
 * An action schema MAY declare the `action` discriminator itself
 * (`z.strictObject({ action: z.literal('issue'), ... })`, the contracts idiom
 * where each action schema is one branch of a discriminated union).
 *
 * Contract: arc owns the discriminator. The router validates `action` itself
 * (top-level enum + per-branch `const`), the handler's `data` never carries it
 * (HTTP and MCP alike), and `parse: true` parses the body WITH `action` when the
 * schema declares it, then hands the handler the output without it.
 *
 * Before: `withParsedInput` parsed the action-stripped `data`, so a strict schema
 * declaring `action` failed with a missing `action` (FLOW OCC records lane,
 * G-W2REC-2). And a schema-declared `action: { const }` overrode the top-level
 * `action` enum, so one declaring action narrowed every other action's body.
 */
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BaseController } from "../../src/core/BaseController.js";
import { buildActionBodySchema } from "../../src/core/createActionRouter.js";
import { defineAction } from "../../src/core/defineAction.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { convertActionSchemaToZod } from "../../src/integrations/mcp/action-tools.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

const issueSchema = z.strictObject({
  action: z.literal("issue"),
  holder: z.string().trim(),
  copies: z.number().int().default(1),
});

describe("action schema that declares the `action` discriminator", () => {
  let app: FastifyInstance;
  let id: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("ActionSchemaDiscriminator");
    const repo = createMockRepository(Model);
    const resource = defineResource({
      name: "discdecl",
      prefix: "/discdecl",
      adapter: createMongooseAdapter(Model, repo),
      controller: new BaseController(repo, { resourceName: "discdecl", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        issue: defineAction({
          schema: issueSchema,
          parse: true,
          permissions: allowPublic(),
          handler: async (_id, data) => ({ got: data }),
        }),
        // Same idiom without `parse`: data is what AJV accepted, minus `action`.
        returned: defineAction({
          schema: z.strictObject({ action: z.literal("returned"), by: z.string() }),
          permissions: allowPublic(),
          handler: async (_id, data) => ({ got: data }),
        }),
        // Refinement reading `action`: the parse must see it.
        lost: defineAction({
          schema: z
            .strictObject({ action: z.literal("lost"), note: z.string() })
            .refine((v) => v.action === "lost", { message: "action must be lost" }),
          parse: true,
          permissions: allowPublic(),
          handler: async (_id, data) => ({ got: data }),
        }),
        // Does NOT declare `action`: unaffected by the others declaring it.
        archive: defineAction({
          schema: z.strictObject({ reason: z.string() }),
          parse: true,
          permissions: allowPublic(),
          handler: async (_id, data) => ({ got: data }),
        }),
      },
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
    const [doc] = await Model.create([{ name: "x", isActive: true }]);
    id = String(doc._id);
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/discdecl/${id}/action`, payload });

  it("parse: true parses with `action` and hands the handler the output without it", async () => {
    const res = await post({ action: "issue", holder: "  ops  " });
    expect(res.statusCode).toBe(200);
    expect(res.json().got).toEqual({ holder: "ops", copies: 1 });
  });

  it("parse: true still rejects an unknown field (strictness kept)", async () => {
    const res = await post({ action: "issue", holder: "ops", extra: 1 });
    expect(res.statusCode).toBe(400);
  });

  it("without parse, data is the accepted body minus `action`", async () => {
    const res = await post({ action: "returned", by: "desk" });
    expect(res.statusCode).toBe(200);
    expect(res.json().got).toEqual({ by: "desk" });
  });

  it("a refinement that reads `action` sees it", async () => {
    const res = await post({ action: "lost", note: "gone" });
    expect(res.statusCode).toBe(200);
    expect(res.json().got).toEqual({ note: "gone" });
  });

  it("an action that does not declare `action` is unaffected", async () => {
    const res = await post({ action: "archive", reason: "old" });
    expect(res.statusCode).toBe(200);
    expect(res.json().got).toEqual({ reason: "old" });
  });

  it("the route body keeps arc's discriminator: top-level enum, per-branch const", () => {
    const schema = buildActionBodySchema(["issue", "archive"], {
      issue: issueSchema as unknown as Record<string, unknown>,
      archive: { type: "object", properties: { reason: { type: "string" } } },
    });
    const top = schema.properties as Record<string, Record<string, unknown>>;
    expect(top.action).toEqual({ type: "string", enum: ["issue", "archive"] });
    const branches = schema.oneOf as Array<{
      properties: Record<string, unknown>;
      required: string[];
    }>;
    expect(branches[0]?.properties.action).toEqual({ type: "string", const: "issue" });
    expect(branches[1]?.properties.action).toEqual({ type: "string", const: "archive" });
    expect(branches[0]?.required.filter((f) => f === "action")).toEqual(["action"]);
  });

  it("the MCP tool input does not advertise `action` (the tool name is the action)", () => {
    const shape = convertActionSchemaToZod(issueSchema as unknown as Record<string, unknown>);
    expect(Object.keys(shape).sort()).toEqual(["copies", "holder"]);
  });
});
