/**
 * The HTTP contract for the two strict switches.
 *
 * `silent-input-drop.test.ts` pins the unit behaviour of `BodySanitizer` and
 * `ArcQueryParser` directly. Neither of those sees a request, so neither can
 * answer the question a caller actually cares about: what STATUS comes back.
 * That matters here because both fixes turn a silent 200 into a refusal, and a
 * refusal is only useful if it arrives as 4xx — an error escaping as 500, or
 * being swallowed by the pipeline, would trade a silent wrong answer for a
 * loud useless one.
 *
 * It also covers the wiring, which the unit tests cannot: `onImmutableWrite` is
 * a resource-config field, so this proves it actually reaches the sanitizer
 * that runs on a real update.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("strict input handling — over HTTP", () => {
  let app: FastifyInstance;
  let id: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("StrictInput");
    const repo = createMockRepository(Model);
    const doc = await Model.create({ name: "Widget", description: "purchase" });
    id = String(doc._id);

    const resource = defineResource({
      name: "strictitem",
      adapter: createMongooseAdapter({ model: Model, repository: repo }),
      controller: new BaseController(repo, { resourceName: "strictitem", tenantField: false }),
      permissions: {
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
      // The per-resource opt-in — this is also the assertion that the option
      // reaches BodySanitizer at all, which no unit test can make.
      onImmutableWrite: "reject",
      schemaOptions: { fieldRules: { description: { immutable: true } } },
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
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("answers 403 — not a silent 200 — when an update carries an immutable field", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/strictitems/${id}`,
      payload: { description: "rent" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("description");
  });

  it("still accepts an update that touches only mutable fields", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/strictitems/${id}`,
      payload: { name: "Renamed" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("leaves the immutable value intact after the refusal", async () => {
    const res = await app.inject({ method: "GET", url: `/strictitems/${id}` });
    expect(JSON.parse(res.body).description).toBe("purchase");
  });
});
