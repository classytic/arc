/**
 * Contract: action-router body schema must be robust to any reasonable host
 * AJV configuration.
 *
 * Reported symptom (Commerce BD): `data.amount` / `data.reason` arriving
 * undefined under host's `removeAdditional: 'all'`. Hypothesis was that
 * arc's `buildActionBodySchema` produces a top-level schema with NO
 * `properties` (just `oneOf`), so AJV's strip pass would clear branch fields
 * before `oneOf` ever evaluates.
 *
 * Empirically false: AJV's `oneOf` evaluation considers per-branch
 * `properties` when computing the "used by some subschema" set that
 * `removeAdditional` honors. These tests lock that contract — under EVERY
 * realistic `removeAdditional` mode (`'all'`, `'failing'`, `true`), with
 * BOTH strict-by-default Zod branches AND permissive plain-JSON-Schema
 * branches, the per-branch fields survive validation and reach the handler.
 *
 * Arc's own `createApp` sets `removeAdditional: false` ([../../src/factory/createApp.ts])
 * so the in-arc test suite doesn't exercise this — but a host registering
 * `resource.toPlugin()` into its own Fastify will inherit Fastify's defaults
 * unless told otherwise. The schema arc emits has to hold up there too.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

describe("action body schema robust to host removeAdditional: 'all'", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function runUnderAjvMode(mode: "all" | "failing" | true | false): Promise<{
    statusCode: number;
    seen: Record<string, unknown>;
  }> {
    const Model = createMockModel(
      `ActionStripRepro_${String(mode).replace(/[^a-z]/gi, "") || "x"}`,
    );
    const repo = createMockRepository(Model);
    const [item] = await Model.create([{ name: "n", isActive: true }]);
    const itemId = String(item._id);

    const seen: Record<string, unknown> = {};
    const resource = defineResource({
      name: `actionstrip-${String(mode).replace(/[^a-z]/gi, "") || "x"}`,
      prefix: `/actionstrip-${String(mode).replace(/[^a-z]/gi, "") || "x"}`,
      adapter: createMongooseAdapter(Model, repo),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      actions: {
        hold: {
          handler: async (id, data) => {
            seen.hold = data;
            return { id, ...data };
          },
          permissions: allowPublic(),
          schema: z.object({
            amount: z.number(),
            reason: z.string(),
          }) as unknown as Record<string, unknown>,
        },
        resume: {
          handler: async (id, data) => {
            seen.resume = data;
            return { id, ...data };
          },
          permissions: allowPublic(),
          schema: z.object({
            rules: z.array(z.string()),
          }) as unknown as Record<string, unknown>,
        },
      },
      actionPermissions: allowPublic(),
    });

    const app = Fastify({
      logger: false,
      ajv: { customOptions: { removeAdditional: mode, coerceTypes: true, useDefaults: true } },
    });
    await app.register(resource.toPlugin());
    await app.ready();
    cleanup = async () => {
      await app.close();
    };

    const res = await app.inject({
      method: "POST",
      url: `/actionstrip-${String(mode).replace(/[^a-z]/gi, "") || "x"}/${itemId}/action`,
      payload: { action: "hold", amount: 100, reason: "fraud check" },
    });

    return { statusCode: res.statusCode, seen };
  }

  it("per-branch fields survive under removeAdditional: 'all'", async () => {
    await setupTestDatabase();
    try {
      const { statusCode, seen } = await runUnderAjvMode("all");
      expect(statusCode).toBe(200);
      expect(seen.hold).toMatchObject({ amount: 100, reason: "fraud check" });
    } finally {
      await teardownTestDatabase();
    }
  });

  it("per-branch fields survive under removeAdditional: 'failing'", async () => {
    await setupTestDatabase();
    try {
      const { statusCode, seen } = await runUnderAjvMode("failing");
      expect(statusCode).toBe(200);
      expect(seen.hold).toMatchObject({ amount: 100, reason: "fraud check" });
    } finally {
      await teardownTestDatabase();
    }
  });

  it("per-branch fields survive under removeAdditional: true", async () => {
    await setupTestDatabase();
    try {
      const { statusCode, seen } = await runUnderAjvMode(true);
      expect(statusCode).toBe(200);
      expect(seen.hold).toMatchObject({ amount: 100, reason: "fraud check" });
    } finally {
      await teardownTestDatabase();
    }
  });

  // The Zod path produces strict-by-default branches (`additionalProperties: false`).
  // Cover the OTHER shape too: plain JSON Schema branches with NO
  // `additionalProperties` declaration (permissive). This is the schema shape
  // a host writing schemas longhand most likely emits.
  it("permissive plain-JSON-Schema branches also survive removeAdditional: 'all'", async () => {
    await setupTestDatabase();
    try {
      const Model = createMockModel("ActionStripPermissive");
      const repo = createMockRepository(Model);
      const [item] = await Model.create([{ name: "n", isActive: true }]);
      const itemId = String(item._id);

      const seen: Record<string, unknown> = {};
      const resource = defineResource({
        name: "actionstrip-perm",
        prefix: "/actionstrip-perm",
        adapter: createMongooseAdapter(Model, repo),
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
        actions: {
          hold: {
            handler: async (id, data) => {
              seen.hold = data;
              return { id, ...data };
            },
            permissions: allowPublic(),
            schema: {
              type: "object",
              properties: {
                amount: { type: "number" },
                reason: { type: "string" },
              },
              required: ["amount", "reason"],
              // additionalProperties NOT declared — permissive.
            },
          },
          resume: {
            handler: async (id, data) => {
              seen.resume = data;
              return { id, ...data };
            },
            permissions: allowPublic(),
            schema: {
              type: "object",
              properties: {
                rules: { type: "array", items: { type: "string" } },
              },
              required: ["rules"],
            },
          },
        },
        actionPermissions: allowPublic(),
      });

      const app = Fastify({
        logger: false,
        ajv: { customOptions: { removeAdditional: "all", coerceTypes: true, useDefaults: true } },
      });
      await app.register(resource.toPlugin());
      await app.ready();
      cleanup = async () => {
        await app.close();
      };

      const res = await app.inject({
        method: "POST",
        url: `/actionstrip-perm/${itemId}/action`,
        payload: { action: "hold", amount: 100, reason: "fraud check" },
      });

      expect(res.statusCode).toBe(200);
      expect(seen.hold).toMatchObject({ amount: 100, reason: "fraud check" });
    } finally {
      await teardownTestDatabase();
    }
  });

  // ============================================================================
  // Commerce BD scenario — the failing case my earlier "doesn't reproduce"
  // claim missed. The Commerce schemas have ALL-OPTIONAL fields plus an
  // empty-schema sibling action (`verify`), which exposes a different AJV
  // failure mode: under `removeAdditional: 'all'` AJV strips per-branch as
  // it walks `oneOf`, mutating the body before discrimination completes.
  // ============================================================================

  it("all-optional fields + empty-schema sibling — fields survive (Commerce BD)", async () => {
    await setupTestDatabase();
    try {
      const Model = createMockModel("ActionStripCommerce");
      const repo = createMockRepository(Model);
      const [item] = await Model.create([{ name: "n", isActive: true }]);
      const itemId = String(item._id);

      const seen: Record<string, unknown> = {};
      const resource = defineResource({
        name: "actionstrip-comm",
        prefix: "/actionstrip-comm",
        adapter: createMongooseAdapter(Model, repo),
        permissions: {
          list: allowPublic(),
          get: allowPublic(),
          create: allowPublic(),
          update: allowPublic(),
          delete: allowPublic(),
        },
        actions: {
          // Empty-schema sibling — no `schema` declared. Under the old
          // `oneOf`-only shape, this branch's `properties: { action }`
          // caused AJV to strip every other field from the body before
          // `oneOf` could discriminate.
          verify: {
            handler: async (id, data) => {
              seen.verify = data;
              return { id, ...data };
            },
            permissions: allowPublic(),
          },
          // All-optional Zod object — `required: ['action']` only. The
          // original symptom: amount/reason arrived as undefined because
          // verify branch had already stripped them.
          hold: {
            handler: async (id, data) => {
              seen.hold = data;
              return { id, ...data };
            },
            permissions: allowPublic(),
            schema: z.object({
              amount: z.number().optional(),
              reason: z.string().optional(),
            }) as unknown as Record<string, unknown>,
          },
          // The third Commerce shape — `z.array(z.unknown()).optional()`,
          // which produces `{ type: 'array', items: {} }` after Zod→JSON Schema
          // conversion. Confirms the `items: {}` shape doesn't trigger
          // any other AJV-strict failure path.
          split: {
            handler: async (id, data) => {
              seen.split = data;
              return { id, ...data };
            },
            permissions: allowPublic(),
            schema: z.object({
              rules: z.array(z.unknown()).optional(),
            }) as unknown as Record<string, unknown>,
          },
        },
        actionPermissions: allowPublic(),
      });

      const app = Fastify({
        logger: false,
        ajv: { customOptions: { removeAdditional: "all", coerceTypes: true, useDefaults: true } },
      });
      await app.register(resource.toPlugin());
      await app.ready();
      cleanup = async () => {
        await app.close();
      };

      // Hold: optional fields must reach the handler
      const holdRes = await app.inject({
        method: "POST",
        url: `/actionstrip-comm/${itemId}/action`,
        payload: { action: "hold", amount: 200000, reason: "fraud check" },
      });
      expect(holdRes.statusCode).toBe(200);
      expect(seen.hold).toMatchObject({ amount: 200000, reason: "fraud check" });

      // Split: array-of-unknown must reach the handler
      const splitRes = await app.inject({
        method: "POST",
        url: `/actionstrip-comm/${itemId}/action`,
        payload: { action: "split", rules: [{ a: 1 }, { b: 2 }] },
      });
      expect(splitRes.statusCode).toBe(200);
      expect(seen.split).toMatchObject({ rules: [{ a: 1 }, { b: 2 }] });

      // Verify (no schema): action survives, no spurious fields injected
      const verifyRes = await app.inject({
        method: "POST",
        url: `/actionstrip-comm/${itemId}/action`,
        payload: { action: "verify" },
      });
      expect(verifyRes.statusCode).toBe(200);
    } finally {
      await teardownTestDatabase();
    }
  });
});
