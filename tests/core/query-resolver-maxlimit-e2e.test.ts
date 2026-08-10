/**
 * The parser cap must survive the WHOLE path, not just `QueryResolver`.
 *
 * The unit tests construct a resolver directly. That is the shape of test the
 * constructor-only version of this fix already passed while changing nothing at
 * runtime — because a resource supplies its parser through `setQueryParser()`,
 * not through the constructor. So the cap is asserted here against a real
 * request instead: `defineResource({ queryParser })` → controller → resolver →
 * `?limit=…`, with more rows in the collection than the framework default.
 */

import { Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { createQueryParser } from "../../src/utils/queryParser.js";
import { createMockModel, setupTestDatabase, teardownTestDatabase } from "../setup.js";

describe("parser max-limit — over HTTP", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("CapItem");
    // The repository caps INDEPENDENTLY (mongokit PaginationEngine defaults to 100).
    // Configure it for 1000 so this test isolates arc's layer — the real deployment
    // had the repo at 1000 too, which is why arc's 100 was the only thing truncating.
    const repo = new Repository(Model as never, [], { maxLimit: 1000 });
    // More than the framework's default cap of 100, so a silent clamp is visible.
    await Model.create(
      Array.from({ length: 150 }, (_, i) => ({ name: `row-${i}`, isActive: true })),
    );

    const resource = defineResource({
      name: "capitem",
      adapter: createMongooseAdapter({ model: Model, repository: repo }),
      controller: new BaseController(repo, { resourceName: "capitem", tenantField: false }),
      // The resource ANSWERS "how large may a page be?" — arc must not apply 100 on top.
      queryParser: createQueryParser({ maxLimit: 1000 }),
      permissions: { list: allowPublic(), get: allowPublic() },
      disabledRoutes: ["create", "update", "delete"],
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

  it("serves a page LARGER than the framework default when the parser allows it", async () => {
    const res = await app.inject({ method: "GET", url: "/capitems?limit=150" });
    expect(res.statusCode).toBe(200);
    // The defect returned exactly 100 — the framework default winning silently.
    expect(JSON.parse(res.body).data).toHaveLength(150);
  });

  it("CLAMPS a limit beyond the cap rather than refusing it", async () => {
    // Both layers that handle `limit` clamp — this parser and `QueryResolver`.
    // The querystring schema used to emit `maximum` and 400 first, making the
    // documented clamp unreachable; a caller that does not inspect the error body
    // renders that 400 as an empty list — a failure disguised as "no results".
    // Asking for more rows than allowed has an obvious right answer: give the max.
    const res = await app.inject({ method: "GET", url: "/capitems?limit=5000" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.length).toBeLessThanOrEqual(1000);
  });
});
