/**
 * Regression: Zod `.positive() / .negative() / .gt() / .lt()` on Fastify routes
 *
 * Before the fix, `schemaConverter` hardcoded `target: 'openapi-3.0'`, which
 * emits the draft-04 boolean form `exclusiveMinimum: true`. Fastify v5's AJV 8
 * is configured for draft-07 and rejects that at route registration:
 *
 *     schema is invalid: data/properties/size/exclusiveMinimum must be number
 *
 * These tests register real Fastify routes (both `routes[]` and `actions`) with
 * Zod schemas that use every exclusive-numeric constraint and verify that
 * (a) registration succeeds and (b) validation actually enforces the constraint.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

describe("Zod + Fastify schema regression (exclusive numeric constraints)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const Model = createMockModel("ZodFastifyReg");
    const repo = createMockRepository(Model);

    const resource = defineResource({
      name: "widget",
      displayName: "Widgets",
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
      // Zod schemas with all four exclusive numeric constraints — each one
      // produced `exclusiveMinimum: true` / `exclusiveMaximum: true` under the
      // old `openapi-3.0` target and broke route registration.
      customSchemas: {
        create: {
          body: z.object({
            name: z.string(),
            size: z.number().int().positive(), // exclusiveMinimum
            delta: z.number().negative(), // exclusiveMaximum
            above: z.number().gt(10), // exclusiveMinimum
            below: z.number().lt(100), // exclusiveMaximum
          }),
        },
      },
      routes: [
        {
          method: "POST",
          path: "/compute",
          permissions: allowPublic(),
          schema: {
            body: z.object({
              qty: z.number().int().positive(),
              score: z.number().gt(0).lt(1),
            }),
          },
          handler: async (req, reply) => reply.send({ success: true, data: req.body }),
          raw: true,
        },
      ],
    });

    app = await createApp({
      resources: [resource],
      auth: { mode: "none" },
    });
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("registers POST /widgets with Zod .positive() / .negative() / .gt() / .lt() body", () => {
    // If registration had failed, beforeAll would have thrown.
    expect(app).toBeDefined();
  });

  it("rejects body that violates .positive() (size must be > 0)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      payload: { name: "a", size: 0, delta: -1, above: 20, below: 50 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects body that violates .negative() (delta must be < 0)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      payload: { name: "a", size: 5, delta: 0, above: 20, below: 50 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects body that violates .gt(10) (above must be > 10)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      payload: { name: "a", size: 5, delta: -1, above: 10, below: 50 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects body that violates .lt(100) (below must be < 100)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      payload: { name: "a", size: 5, delta: -1, above: 20, below: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts body that satisfies every exclusive constraint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/widgets",
      payload: { name: "ok", size: 5, delta: -1, above: 20, below: 50 },
    });
    expect(res.statusCode).toBeLessThan(400);
  });

  it("routes[].schema also accepts Zod with exclusive constraints", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/widgets/compute",
      payload: { qty: 3, score: 0.5 },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST",
      url: "/widgets/compute",
      payload: { qty: 0, score: 0.5 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
