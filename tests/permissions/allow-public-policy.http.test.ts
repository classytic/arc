/**
 * `allowPublic({ policy })` over real HTTP — a real auth plugin (JWT), a real
 * mongokit repository, a real Mongo.
 *
 * The reason this helper exists is only visible with an auth plugin present:
 * arc treats a check function as PROTECTED unless it carries `_isPublic`, so a
 * hand-written "public, but only published rows" check —
 * `() => allow({ policy })` — answers every anonymous visitor with a 401. The
 * last describe block pins that trap, so the contrast is recorded next to the
 * fix rather than in a comment.
 *
 * What must hold for a row-filtered public resource:
 *   - an anonymous visitor is served (200, not 401) and sees only admitted rows;
 *   - a query parameter cannot widen the policy (`?status=hidden` is ANDed with
 *     it, not substituted for it);
 *   - a filtered-out row is a 404 by id, not a 200;
 *   - the same gate gives a signed-in author their own non-public row, and
 *     staff everything, when the resolver says so;
 *   - a resolver that returns nothing fails CLOSED with a 403 — never an
 *     unfiltered 200, and never a 401 inviting the visitor to sign in.
 */

import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allow, allowPublic } from "../../src/permissions/index.js";
import type { PermissionCheck } from "../../src/permissions/types.js";
import { createTestApp } from "../../src/testing/testApp.js";
import { createMockRepository, setupTestDatabase, teardownTestDatabase } from "../setup.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const AUTHOR = "author-1";
const VISIBLE = { status: { $in: ["published", "flagged"] } };

/** One collection, four rows: two a stranger may see, two they may not. */
function reviewModel(name: string): mongoose.Model<unknown> {
  if (mongoose.models[name]) return mongoose.models[name] as mongoose.Model<unknown>;
  return mongoose.model(
    name,
    new mongoose.Schema({ title: String, status: String, authorId: String }, { timestamps: true }),
  );
}

async function seed(model: mongoose.Model<unknown>): Promise<Record<string, string>> {
  const create = (doc: Record<string, unknown>) =>
    (model as unknown as { create: (d: unknown) => Promise<{ _id: unknown }> }).create(doc);
  const ids: Record<string, string> = {};
  for (const [key, doc] of Object.entries({
    published: { title: "Great course", status: "published", authorId: "someone" },
    flagged: { title: "Under review", status: "flagged", authorId: "someone" },
    hidden: { title: "Moderated away", status: "hidden", authorId: "someone" },
    ownPending: { title: "My pending review", status: "pending", authorId: AUTHOR },
  })) {
    ids[key] = String((await create(doc))._id);
  }
  return ids;
}

function resourceWith(name: string, model: mongoose.Model<unknown>, gate: PermissionCheck) {
  const repo = createMockRepository(model);
  return defineResource({
    name,
    prefix: `/${name}`,
    adapter: { type: "mongoose", repository: repo, model } as never,
    controller: new BaseController(repo as never, { resourceName: name, tenantField: false }),
    permissions: { list: gate, get: gate },
    disabledRoutes: ["create", "update", "delete"],
  });
}

const titles = (body: string): string[] =>
  ((JSON.parse(body) as { data?: Array<{ title: string }> }).data ?? []).map((r) => r.title).sort();

describe("allowPublic({ policy }) over HTTP", () => {
  let ctx: Ctx;
  let ids: Record<string, string>;

  beforeAll(async () => {
    await setupTestDatabase();
    const Review = reviewModel("AllowPublicPolicyReview");
    ids = await seed(Review);

    const scopeAware = allowPublic({
      policy: (c) => {
        const user = c.user as { id?: string; roles?: string[] } | null;
        if (user?.roles?.includes("staff")) return {}; // staff: unrestricted
        return user?.id ? { $or: [VISIBLE, { authorId: user.id }] } : VISIBLE;
      },
    });

    ctx = await createTestApp({
      db: false,
      authMode: "jwt",
      resources: [
        resourceWith("reviews", Review, allowPublic({ policy: VISIBLE })),
        resourceWith("scoped", Review, scopeAware),
        resourceWith("broken", Review, allowPublic({ policy: (() => undefined) as never })),
        // THE TRAP: the hand-written equivalent with no `_isPublic` flag.
        resourceWith("handwritten", Review, (() => allow({ policy: VISIBLE })) as PermissionCheck),
      ],
    });
    ctx.auth?.register("author", { user: { id: AUTHOR, roles: ["user"] } });
    ctx.auth?.register("staff", { user: { id: "staff-1", roles: ["staff"] } });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await teardownTestDatabase();
  });

  const get = (url: string, as?: "author" | "staff") =>
    ctx.app.inject({ method: "GET", url, headers: (as && ctx.auth?.as(as).headers) || {} });

  describe("static policy", () => {
    it("serves an anonymous visitor (200, not 401) only the admitted rows", async () => {
      const res = await get("/reviews");
      expect(res.statusCode).toBe(200);
      expect(titles(res.body)).toEqual(["Great course", "Under review"]);
    });

    it("cannot be widened by a query parameter — ?status=hidden is ANDed, not substituted", async () => {
      const res = await get("/reviews?status=hidden");
      expect(res.statusCode).toBe(200);
      expect(titles(res.body)).toEqual([]);
    });

    it("answers a filtered-out row by id with 404, an admitted one with 200", async () => {
      expect((await get(`/reviews/${ids.hidden}`)).statusCode).toBe(404);
      expect((await get(`/reviews/${ids.published}`)).statusCode).toBe(200);
    });
  });

  describe("scope-aware resolver — one gate, a different view per caller", () => {
    it("a stranger sees only public rows", async () => {
      expect(titles((await get("/scoped")).body)).toEqual(["Great course", "Under review"]);
    });

    it("the author ALSO sees their own pending review — and nobody else's hidden one", async () => {
      expect(titles((await get("/scoped", "author")).body)).toEqual([
        "Great course",
        "My pending review",
        "Under review",
      ]);
      expect((await get(`/scoped/${ids.ownPending}`, "author")).statusCode).toBe(200);
      expect((await get(`/scoped/${ids.ownPending}`)).statusCode).toBe(404);
    });

    it("staff get {} from the resolver — unrestricted", async () => {
      expect(titles((await get("/scoped", "staff")).body)).toHaveLength(4);
    });
  });

  describe("fail-closed", () => {
    it("a resolver that returns nothing is a 403 — not an unfiltered 200, not a 401", async () => {
      const res = await get("/broken");
      expect(res.statusCode).toBe(403);
    });
  });

  describe("the trap this helper removes", () => {
    it("a hand-written allow({ policy }) with no _isPublic flag answers anonymous visitors 401", async () => {
      // Identical enforcement intent to /reviews — only the missing flag differs.
      expect((await get("/handwritten")).statusCode).toBe(401);
      expect((await get("/reviews")).statusCode).toBe(200);
    });
  });
});
