/**
 * Cross-surface enforcement conformance (arc 2.30).
 *
 * Regression guard for the review finding "aggregations discard row policies":
 * a permission that returns `allow({ policy })` must restrict AGGREGATION
 * queries exactly as it restricts CRUD reads. The decision's `policy` has to
 * reach the aggregation filter (and a `deny` must fail closed), proving the
 * same AuthorizationDecision is enforced on every surface — not just CRUD.
 *
 * `repo.aggregate` is stubbed so the assertion is adapter-agnostic: we capture
 * the `AggRequest` arc hands the kit and assert the row policy is present in the
 * `$match` filter.
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defineAggregation } from "../../../src/core/aggregation/index.js";
import { BaseController } from "../../../src/core/BaseController.js";
import { defineResource } from "../../../src/core/defineResource.js";
import { createApp } from "../../../src/factory/createApp.js";
import { allow, deny } from "../../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../../setup.js";

describe("aggregation enforces the decision's row policy (cross-surface parity)", () => {
  let app: FastifyInstance;
  // biome-ignore lint/suspicious/noExplicitAny: stubbed for assertions
  let aggregateStub: any;

  beforeAll(async () => {
    await setupTestDatabase();
    const Model = createMockModel("DocAgg");
    const repo = createMockRepository(Model) as Record<string, unknown>;
    aggregateStub = vi.fn().mockResolvedValue({ rows: [{ n: 1 }] });
    repo.aggregate = aggregateStub;

    const resource = defineResource({
      name: "doc",
      prefix: "/docs",
      adapter: createMongooseAdapter(Model, repo as never),
      controller: new BaseController(repo as never, { resourceName: "doc", tenantField: false }),
      permissions: {
        list: () => allow({ policy: { ownerId: "u1" } }),
        get: () => allow({ policy: { ownerId: "u1" } }),
        create: () => allow(),
        update: () => allow(),
        delete: () => allow(),
      },
      aggregations: {
        // Gated by an ownership-style row policy — MUST scope the aggregation.
        ownedCount: defineAggregation({
          measures: { n: { count: true } },
          permissions: () => allow({ policy: { ownerId: "u1" } }),
        }),
        // Explicitly denied — must fail closed with 403/401.
        secret: defineAggregation({
          measures: { n: { count: true } },
          permissions: () => deny("nope"),
        }),
      },
    });

    app = await createApp({ plugins: async (f) => f.register(resource.toPlugin()) });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDatabase();
  });

  it("folds the decision's policy into the AggRequest filter handed to the kit", async () => {
    aggregateStub.mockClear();
    const res = await app.inject({ method: "GET", url: "/docs/aggregations/ownedCount" });
    expect(res.statusCode).toBe(200);

    expect(aggregateStub).toHaveBeenCalledTimes(1);
    const aggReq = aggregateStub.mock.calls[0][0] as { filter?: Record<string, unknown> };
    // The row policy `{ ownerId: "u1" }` must be present in the filter arc
    // compiles for the kit — the aggregation is scoped, not wide-open.
    expect(JSON.stringify(aggReq.filter ?? {})).toContain("ownerId");
    expect(JSON.stringify(aggReq.filter ?? {})).toContain("u1");
  });

  it("fails closed when the aggregation permission denies", async () => {
    aggregateStub.mockClear();
    const res = await app.inject({ method: "GET", url: "/docs/aggregations/secret" });
    expect([401, 403]).toContain(res.statusCode);
    // The denied aggregation must never reach the repository.
    expect(aggregateStub).not.toHaveBeenCalled();
  });
});
