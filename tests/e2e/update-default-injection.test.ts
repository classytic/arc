/**
 * Regression: PATCH must not inject Mongoose defaults (mongokit ≥3.16.1).
 *
 * arc's `createApp` runs Fastify/AJV with `useDefaults: true`. Before
 * mongokit 3.16.1, `buildCrudSchemasFromModel` carried a nullable field's
 * `default: null` into the UPDATE body schema, so a PATCH that omitted the
 * field had `null` INJECTED by AJV and the repository `$set` it — silently
 * nulling stored data on a content-only save (the canonical case: a
 * `publishedAt` date wiped on a title edit).
 *
 * mongokit 3.16.1 strips defaults from the update schema. This test drives
 * the WHOLE arc pipeline (route schema synthesis → AJV → BodySanitizer →
 * mongokit `$set`) to prove the field survives a partial update. It only
 * passes with the fixed kit — it fails against 3.16.0.
 */

import { Repository, buildCrudSchemasFromModel } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

describe("PATCH does not inject Mongoose defaults (mongokit >=3.16.1)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();

    const ArticleSchema = new mongoose.Schema(
      {
        title: { type: String, required: true },
        // The bug trigger: nullable field carrying `default: null`.
        publishedAt: { type: Date, default: null },
        // A nullable enum — the other shape mongokit widens with default: null.
        priceMode: { type: String, enum: ["fixed", "tiered"], default: null },
      },
      { timestamps: true },
    );
    const ArticleModel =
      mongoose.models.UpdInjectArticle || mongoose.model("UpdInjectArticle", ArticleSchema);
    const repo = new Repository(ArticleModel);

    // Wire mongokit's schema generator so arc's update route uses the
    // kit-generated (now default-stripped) update body — the realistic setup.
    const adapter = createMongooseAdapter({
      model: ArticleModel,
      repository: repo,
      schemaGenerator: buildCrudSchemasFromModel,
    });

    const article = defineResource({
      name: "article",
      adapter,
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    await ArticleModel.deleteMany({});

    app = await createApp({ preset: "testing", auth: false, resources: [article] });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await teardownTestDatabase();
  });

  it("preserves a nullable `publishedAt` when a PATCH omits it", async () => {
    // arc CRUD returns the doc directly on create/get; lists wrap in `data`.
    const unwrap = (r: { json: () => Record<string, unknown> }): Record<string, unknown> => {
      const body = r.json();
      const inner = body.data;
      return inner && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : body;
    };

    const published = "2026-01-15T00:00:00.000Z";
    const created = await app.inject({
      method: "POST",
      url: "/articles",
      payload: { title: "Original", publishedAt: published, priceMode: "fixed" },
    });
    expect(created.statusCode).toBe(201);
    const createdDoc = unwrap(created);
    const id = createdDoc._id;
    expect(new Date(createdDoc.publishedAt as string).toISOString()).toBe(published);

    // Content-only edit — publishedAt + priceMode are NOT in the body.
    const patched = await app.inject({
      method: "PATCH",
      url: `/articles/${id}`,
      payload: { title: "Updated" },
    });
    expect(patched.statusCode).toBe(200);

    const fetched = await app.inject({ method: "GET", url: `/articles/${id}` });
    const doc = unwrap(fetched);
    expect(doc.title).toBe("Updated");
    // The fix: these were NOT injected/overwritten with their `default: null`.
    expect(doc.publishedAt).not.toBeNull();
    expect(new Date(doc.publishedAt).toISOString()).toBe(published);
    expect(doc.priceMode).toBe("fixed");
  });
});
