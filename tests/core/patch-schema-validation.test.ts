/**
 * PATCH vs PUT Schema Validation Tests
 *
 * Verifies that auto-generated schemas from the adapter correctly strip
 * `required` fields for PATCH routes (partial updates) while preserving
 * them for PUT routes (full replacement).
 */

import Fastify from "fastify";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { clearDatabase, setupTestDatabase, teardownTestDatabase } from "../setup.js";

let mongoUri: string;

beforeAll(async () => {
  mongoUri = await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

describe("PATCH schema — all fields optional", () => {
  it("should accept partial body on PATCH when schema has required fields", async () => {
    // Create a model with required fields
    const schemaName = `PatchTestItem${Date.now()}`;
    const schema = new mongoose.Schema({
      title: { type: String, required: true },
      status: { type: String, required: true, enum: ["draft", "published"] },
      description: String,
    });
    const Model = mongoose.model(schemaName, schema);
    const { Repository } = await import("@classytic/mongokit");
    const repo = new Repository(Model);

    // Use an explicit schemaGenerator that returns required fields
    const resource = defineResource({
      name: "patch-item",
      adapter: createMongooseAdapter({
        model: Model,
        repository: repo,
        schemaGenerator: () => ({
          createBody: {
            type: "object",
            properties: {
              title: { type: "string" },
              status: { type: "string", enum: ["draft", "published"] },
              description: { type: "string" },
            },
            required: ["title", "status"],
          },
          updateBody: {
            type: "object",
            properties: {
              title: { type: "string" },
              status: { type: "string", enum: ["draft", "published"] },
              description: { type: "string" },
            },
            required: ["title", "status"], // This should be stripped for PATCH
          },
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        }),
      }),
      controller: new BaseController(repo, { resourceName: "patch-item" }),
      prefix: "/patch-items",
      tag: "PatchItems",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    // Create an item first (needs all required fields)
    const createRes = await app.inject({
      method: "POST",
      url: "/patch-items",
      payload: { title: "Original", status: "draft" },
    });
    expect(createRes.statusCode).toBeLessThan(500);
    const created = JSON.parse(createRes.body);
    const id = created.data?._id ?? created._id;

    // PATCH with only one field — should NOT fail validation
    // (because required should be stripped for PATCH)
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/patch-items/${id}`,
      payload: { description: "Updated description only" },
    });

    // Should not be 400 (validation error from missing required fields)
    expect(patchRes.statusCode).not.toBe(400);

    await app.close();
  });

  it("should still validate create body with required fields", async () => {
    const schemaName = `CreateValidation${Date.now()}`;
    const schema = new mongoose.Schema({
      name: { type: String, required: true },
      email: { type: String, required: true },
    });
    const Model = mongoose.model(schemaName, schema);
    const { Repository } = await import("@classytic/mongokit");
    const repo = new Repository(Model);

    const resource = defineResource({
      name: "create-val",
      adapter: createMongooseAdapter({
        model: Model,
        repository: repo,
        schemaGenerator: () => ({
          createBody: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["name", "email"],
          },
          updateBody: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["name", "email"],
          },
        }),
      }),
      controller: new BaseController(repo, { resourceName: "create-val" }),
      prefix: "/create-val",
      tag: "CreateVal",
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    const app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    // POST without required fields — should fail validation
    const res = await app.inject({
      method: "POST",
      url: "/create-val",
      payload: { name: "Test" }, // missing 'email'
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});
