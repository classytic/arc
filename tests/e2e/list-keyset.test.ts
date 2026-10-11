/**
 * Keyset lists over HTTP: `?mode=keyset` (or a cursor) reaches the repository's keyset mode, a
 * walk by `next` and back by `prev` covers every row exactly once, a refused cursor is the kit's
 * closed 400, and a list with no mode stays offset (with its count provenance).
 */

import * as mongokit from "@classytic/mongokit";
import { QueryParser, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

/**
 * Closed cursor codes and count provenance arrive with mongokit's Stage-1 build; on an older
 * installed mongokit those two cases are skipped, not passed.
 */
const STAGE1_MONGOKIT = "PAGINATION_ERROR_CODES" in mongokit;

let app: FastifyInstance;
let Ledger: mongoose.Model<{ ref: string; amount: number }>;

beforeAll(async () => {
  await setupTestDatabase();
  Ledger =
    mongoose.models.KsLedger ||
    mongoose.model(
      "KsLedger",
      new mongoose.Schema({ ref: String, amount: Number }, { timestamps: true }),
    );
  const repo = new Repository(Ledger);
  const ledger = defineResource({
    name: "entry",
    prefix: "/entries",
    adapter: createMongooseAdapter({ model: Ledger, repository: repo }),
    queryParser: new QueryParser({
      allowedFilterFields: ["ref"],
      allowedSortFields: ["amount", "_id"],
    }),
    tenantField: false,
    permissions: { list: allowPublic(), get: allowPublic() },
  });
  app = await createApp({
    preset: "development",
    auth: { type: "jwt", jwt: { secret: "test-secret-for-keyset-lists-32chars" } },
    logger: false,
    helmet: false,
    rateLimit: false,
    plugins: async (fastify) => {
      await fastify.register(ledger.toPlugin());
    },
  });
});

afterAll(async () => {
  if (app) await app.close();
  await teardownTestDatabase();
});

beforeEach(async () => {
  await Ledger.deleteMany({});
  // Duplicate sort values on purpose: the walk must break ties by `_id`, never skip or repeat.
  await Ledger.create(
    Array.from({ length: 23 }, (_, i) => ({ ref: `JE-${i}`, amount: (i % 4) * 100 })),
  );
});

type Page = {
  method: string;
  data: Array<{ _id: string; ref: string }>;
  next: string | null;
  prev?: string | null;
  hasMore: boolean;
  hasPrev?: boolean;
};

async function list(qs: string): Promise<{ status: number; body: Page & Record<string, unknown> }> {
  const res = await app.inject({ method: "GET", url: `/entries?${qs}` });
  return { status: res.statusCode, body: res.json() };
}

describe("CRUD list — keyset mode", () => {
  it("?mode=keyset pages forward to the end and back with no gap and no duplicate", async () => {
    const first = await list("mode=keyset&limit=5&sort=amount");
    expect(first.status).toBe(200);
    expect(first.body.method).toBe("keyset");
    const seen: string[] = first.body.data.map((d) => d.ref);
    let page = first.body;
    const pages: Page[] = [page];
    while (page.next) {
      const res = await list(
        `mode=keyset&limit=5&sort=amount&after=${encodeURIComponent(page.next)}`,
      );
      expect(res.status).toBe(200);
      page = res.body;
      pages.push(page);
      seen.push(...page.data.map((d) => d.ref));
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);

    // Back from the last page by `prev`: the same pages, in reverse.
    let back = pages[pages.length - 1] as Page;
    const backward: string[][] = [back.data.map((d) => d.ref)];
    while (back.prev) {
      const res = await list(
        `mode=keyset&limit=5&sort=amount&before=${encodeURIComponent(back.prev)}`,
      );
      expect(res.status).toBe(200);
      back = res.body;
      backward.unshift(back.data.map((d) => d.ref));
    }
    expect(backward).toEqual(pages.map((p) => p.data.map((d) => d.ref)));
  });

  it.skipIf(!STAGE1_MONGOKIT)(
    "a forged cursor is the kit's closed 400, not a 500 or an empty page",
    async () => {
      const res = await list("mode=keyset&limit=5&sort=amount&after=not-a-cursor");
      expect(res.status).toBe(400);
      // The closed code is repo-core's, shared by every kit.
      expect(res.body.code).toBe("repo.cursor.invalid");
    },
  );

  it("an unknown mode is refused, never read as a filter", async () => {
    const res = await list("mode=sideways&limit=5");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("arc.pagination.invalid_mode");
  });

  it("with no mode the list stays offset, page 1", async () => {
    const res = await list("limit=5&sort=amount");
    expect(res.status).toBe(200);
    expect(res.body.method).toBe("offset");
    expect(res.body.page).toBe(1);
    expect(res.body.total).toBe(23);
  });

  it.skipIf(!STAGE1_MONGOKIT)("an offset list carries its count provenance", async () => {
    const res = await list("limit=5&sort=amount");
    expect(res.body.totalIsEstimate).toBe(false);
    expect("countedAt" in res.body).toBe(true);
  });
});
