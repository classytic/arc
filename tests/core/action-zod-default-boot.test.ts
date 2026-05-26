/**
 * Regression: z.optional().default() in action schemas must not crash boot,
 * and the field must remain optional at the HTTP layer.
 *
 * Repro (Prism SFX/stock work):
 *   role: z.enum(["output", "reference"]).optional().default("output")
 *
 * Two distinct bugs in arc's schema pipeline triggered by this single Zod idiom:
 *
 *  1. BOOT CRASH — Zod v4's `z.toJSONSchema()` emits `default: <value>` on
 *     the property. arc's `buildActionBodySchema` puts that property inside a
 *     `oneOf` branch. AJV with `useDefaults: true` cannot apply defaults
 *     inside `oneOf` branches and throws `strict mode: default is ignored for:
 *     data.role` → `FST_ERR_SCH_VALIDATION_BUILD`, app never reaches ready().
 *
 *     Fix in [../../src/core/schemaIR.ts] `schemaIRToJsonSchemaBranch` (~L130):
 *     strip `default` from each property when emitting a branch's JSON Schema.
 *     The top-level `unionProperties` keep `default`, so AJV still applies it
 *     at request time. (Adding "default" to AJV's `keywords` allowlist was
 *     attempted first — it fails with "Keyword default is already defined"
 *     because AJV ships `default` as a built-in. Do NOT reintroduce that path.)
 *
 *  2. 400 ON OMITTED OPTIONAL FIELD — Zod v4 also emits `.default()` fields
 *     as `required` in the JSON Schema (since defaults make them always-present
 *     at Zod's runtime). At the AJV layer that's wrong: callers expect to omit
 *     the field and have the default apply.
 *
 *     Fix in [../../src/core/schemaIR.ts] `normalizeSchemaIR` (~L96): strip
 *     any `required` entry whose property carries a `default`. AJV then treats
 *     the field as optional and `useDefaults: true` fills it in from the
 *     top-level schema before the handler runs.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BaseController } from "../../src/core/BaseController.js";
import { defineAction } from "../../src/core/defineAction.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

function makeResource(name: string, prefix: string) {
  const Model = createMockModel(`ZodDefault_${name}`);
  const repo = createMockRepository(Model);

  const resource = defineResource({
    name,
    prefix,
    adapter: createMongooseAdapter(Model, repo),
    controller: new BaseController(repo, { resourceName: name, tenantField: false }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    actions: {
      setRole: defineAction({
        // The exact Zod pattern that triggered FST_ERR_SCH_VALIDATION_BUILD.
        schema: z.object({
          role: z.enum(["output", "reference"]).optional().default("output"),
        }),
        id: false,
        permissions: allowPublic(),
        handler: async (_id, data) => ({ role: data.role }),
      }),
      multiDefault: defineAction({
        // Multiple defaulted fields — stress test the property-union walk
        // in buildActionBodySchema that merges branches.
        schema: z.object({
          priority: z.number().optional().default(0),
          label: z.string().optional().default("none"),
          active: z.boolean().optional().default(true),
        }),
        id: false,
        permissions: allowPublic(),
        handler: async (_id, data) => data,
      }),
    },
  });

  return resource;
}

describe("action schema — z.optional().default() does not crash boot", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();
    // The primary assertion: createApp + app.ready() must not throw
    // FST_ERR_SCH_VALIDATION_BUILD. Before the schema IR normalization
    // fix, `z.optional().default(...)` produced a JSON Schema branch
    // Fastify's AJV couldn't compile, exploding on registration.
    app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        await f.register(makeResource("zod-default-role", "/zod-default-role").toPlugin());
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("boots without FST_ERR_SCH_VALIDATION_BUILD", () => {
    // If beforeAll completed, boot succeeded. This test documents the fix.
    expect(app).toBeDefined();
  });

  it("setRole action — omitting an optional+default field is accepted; AJV applies the default", async () => {
    // AJV's useDefaults:true fills in the top-level `default` value before the
    // handler runs, so the handler receives `data.role = "output"` even though
    // the caller sent nothing. The route must NOT return 400 (the original bug).
    const res = await app.inject({
      method: "POST",
      url: "/zod-default-role/action",
      payload: { action: "setRole" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).role).toBe("output");
  });

  it("setRole action — explicit enum value is accepted and echoed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/zod-default-role/action",
      payload: { action: "setRole", role: "reference" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).role).toBe("reference");
  });

  it("multiDefault action — all fields optional; omitting them gives 200 (handler gets undefined)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/zod-default-role/action",
      payload: { action: "multiDefault" },
    });
    expect(res.statusCode).toBe(200);
  });
});
