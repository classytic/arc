/**
 * BaseController — hardening regressions
 *
 * Covers the 5 fixes applied in the v2.9 controller hardening pass:
 *  1. Bulk ops (create/update/delete) MUST pass `{ user, context }` to the repo
 *     so hooks/audit/soft-delete plugins can see the actor.
 *  2. Fallback 404 paths (update/delete/restore/getBySlug) route through
 *     `notFoundResponse()` so `details.code` is always set.
 *  3. `get()` no longer catches errors by string-matching "not found" — real
 *     errors bubble up, `null` is the only 404 signal.
 *  4. SWR revalidation uses the portable `scheduleBackground` helper
 *     (still invokes the callback — we assert the fresh fetch happens).
 *  5. bulkUpdate rejects mixed operator/flat payloads with 400 MIXED_UPDATE_SHAPE.
 *
 * These tests use plain mock repos — no MongoDB, no fastify HTTP layer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Helpers
// ============================================================================

interface MockRepoOverrides {
  [key: string]: unknown;
}

function createMockRepo(overrides: MockRepoOverrides = {}) {
  return {
    getAll: vi.fn().mockResolvedValue({
      docs: [],
      total: 0,
      page: 1,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    }),
    getById: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ _id: "new" }),
    update: vi.fn().mockResolvedValue({ _id: "updated" }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

let _HookSystem: new () => unknown;
async function hooks() {
  if (!_HookSystem) {
    _HookSystem = (await import("../../src/hooks/HookSystem.js")).HookSystem;
  }
  return new _HookSystem();
}

async function req(
  body: unknown = {},
  opts: { user?: unknown; params?: Record<string, string>; query?: Record<string, unknown> } = {},
) {
  return {
    params: opts.params ?? {},
    query: opts.query ?? {},
    body,
    headers: {},
    user: opts.user,
    metadata: { arc: { hooks: await hooks() } },
  };
}

// ============================================================================
// #1 — bulk ops pass user + context
// ============================================================================

describe("BaseController hardening — bulk ops propagate actor identity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("bulkCreate passes { user, context } to repo.createMany", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const createMany = vi.fn().mockResolvedValue([{ _id: "1" }]);
    const repo = createMockRepo({ createMany });
    const ctl = new BaseController(repo, { resourceName: "product" });

    const alice = { _id: "user-alice", roles: ["editor"] };
    await ctl.bulkCreate(await req({ items: [{ name: "A" }] }, { user: alice }));

    const [, options] = createMany.mock.calls[0];
    expect(options).toBeTruthy();
    expect(options.user).toBe(alice);
    expect(options.context).toBeTruthy();
  });

  it("bulkUpdate passes { user, context } to repo.updateMany", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const updateMany = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const repo = createMockRepo({ updateMany });
    const ctl = new BaseController(repo, { resourceName: "product" });

    const bob = { _id: "user-bob" };
    await ctl.bulkUpdate(
      await req({ filter: { status: "draft" }, data: { $set: { status: "x" } } }, { user: bob }),
    );

    const [, , options] = updateMany.mock.calls[0];
    expect(options).toBeTruthy();
    expect(options.user).toBe(bob);
    expect(options.context).toBeTruthy();
  });

  it("bulkDelete passes { user, context } to repo.deleteMany", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 2 });
    const repo = createMockRepo({ deleteMany });
    const ctl = new BaseController(repo, { resourceName: "product" });

    const carol = { _id: "user-carol" };
    await ctl.bulkDelete(await req({ filter: { archived: true } }, { user: carol }));

    const [, options] = deleteMany.mock.calls[0];
    expect(options).toBeTruthy();
    expect(options.user).toBe(carol);
    expect(options.context).toBeTruthy();
  });

  it("bulkDelete hard mode preserves mode flag AND passes actor", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const ctl = new BaseController(createMockRepo({ deleteMany }), { resourceName: "product" });

    const dan = { _id: "user-dan" };
    await ctl.bulkDelete(
      await req({ filter: { old: true }, mode: "hard" }, { user: dan }),
    );
    const [, options] = deleteMany.mock.calls[0];
    expect(options.mode).toBe("hard");
    expect(options.user).toBe(dan);
  });
});

// ============================================================================
// #2 — fallback 404s route through notFoundResponse()
// ============================================================================

describe("BaseController hardening — structured 404 everywhere", () => {
  afterEach(() => vi.restoreAllMocks());

  it("update() 404 from null hook result includes details.code", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    // Existing doc fetched OK, but repo.update returns null (race: doc deleted mid-flight)
    const repo = createMockRepo({
      getById: vi.fn().mockResolvedValue({ _id: "x1" }),
      update: vi.fn().mockResolvedValue(null),
    });
    const ctl = new BaseController(repo, { resourceName: "product" });

    const result = await ctl.update(await req({ name: "y" }, { params: { id: "x1" } }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect((result as { details?: { code?: string } }).details?.code).toBe("NOT_FOUND");
  });

  it("delete() 404 from falsy repo result includes details.code", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const repo = createMockRepo({
      getById: vi.fn().mockResolvedValue({ _id: "x1" }),
      delete: vi.fn().mockResolvedValue({ success: false }),
    });
    const ctl = new BaseController(repo, { resourceName: "product" });

    const result = await ctl.delete(await req({}, { params: { id: "x1" } }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect((result as { details?: { code?: string } }).details?.code).toBe("NOT_FOUND");
  });

  it("delete() 404 from deletedCount=0 includes details.code", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const repo = createMockRepo({
      getById: vi.fn().mockResolvedValue({ _id: "x1" }),
      delete: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 }),
    });
    const ctl = new BaseController(repo, { resourceName: "product" });

    const result = await ctl.delete(await req({}, { params: { id: "x1" } }));

    expect(result.status).toBe(404);
    expect((result as { details?: { code?: string } }).details?.code).toBe("NOT_FOUND");
  });

  it("restore() missing doc returns NOT_FOUND details.code", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const ctl = new BaseController(
      createMockRepo({
        restore: vi.fn(),
        getById: vi.fn().mockResolvedValue(null),
      }),
      { resourceName: "product" },
    );

    const result = await ctl.restore(await req({}, { params: { id: "x1" } }));

    expect(result.status).toBe(404);
    expect((result as { details?: { code?: string } }).details?.code).toBe("NOT_FOUND");
  });

  it("restore() null repo result returns NOT_FOUND details.code", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const ctl = new BaseController(
      createMockRepo({
        restore: vi.fn().mockResolvedValue(null),
        getById: vi.fn().mockResolvedValue({ _id: "x1", deletedAt: new Date() }),
      }),
      { resourceName: "product" },
    );

    const result = await ctl.restore(await req({}, { params: { id: "x1" } }));

    expect(result.status).toBe(404);
    expect((result as { details?: { code?: string } }).details?.code).toBe("NOT_FOUND");
  });
});

// ============================================================================
// #3 — get() no string-match on error messages
// ============================================================================

describe("BaseController hardening — get() error discipline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("bubbles up non-null errors instead of treating 'not found' strings as 404", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    // Simulate a real DB error with 'not found' in the message — historically
    // this was silently mapped to 404. Now it should propagate.
    const repo = createMockRepo({
      getById: vi.fn().mockRejectedValue(new Error("index 'foo' not found on collection bar")),
    });
    const ctl = new BaseController(repo, { resourceName: "product" });

    await expect(ctl.get(await req({}, { params: { id: "anything" } }))).rejects.toThrow(
      /index.*not found/,
    );
  });

  it("returns 404 with details.code when repo returns null", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const repo = createMockRepo({
      getById: vi.fn().mockResolvedValue(null),
    });
    const ctl = new BaseController(repo, { resourceName: "product" });

    const result = await ctl.get(await req({}, { params: { id: "missing" } }));

    expect(result.status).toBe(404);
    expect((result as { details?: { code?: string } }).details?.code).toBeTruthy();
  });

  it("propagates connection errors as 500-class (not mapped to 404)", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const repo = createMockRepo({
      getById: vi.fn().mockRejectedValue(new Error("ECONNREFUSED connect 127.0.0.1:27017")),
    });
    const ctl = new BaseController(repo, { resourceName: "product" });

    await expect(ctl.get(await req({}, { params: { id: "x" } }))).rejects.toThrow(/ECONNREFUSED/);
  });
});

// ============================================================================
// #4 — SWR revalidation callback still fires (via scheduleBackground)
// ============================================================================

describe("BaseController hardening — SWR uses portable scheduler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stale cache entry triggers background revalidation", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const freshDocs = [{ _id: "fresh" }];
    const getAll = vi.fn().mockResolvedValue({
      docs: freshDocs,
      total: 1,
      page: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    });
    const repo = createMockRepo({ getAll });
    const ctl = new BaseController(repo, {
      resourceName: "product",
      cache: { staleTime: 60, gcTime: 300 },
    });

    // Hand-craft a queryCache mock: first call returns a stale entry, set is spied.
    const cacheStore = new Map<string, unknown>();
    const qc = {
      async getResourceVersion() {
        return 1;
      },
      async get<T>(key: string) {
        if (cacheStore.has(key)) {
          return { data: cacheStore.get(key) as T, status: "stale" as const };
        }
        return { data: undefined as T, status: "miss" as const };
      },
      set: vi.fn(async (key: string, value: unknown) => {
        cacheStore.set(key, value);
      }),
    };

    // Prime one cached entry so it comes back as "stale"
    cacheStore.set(
      (await import("../../src/cache/keys.js")).buildQueryKey("product", "list", 1, {}),
      { docs: [{ _id: "stale" }], total: 1, page: 1, pages: 1, hasNext: false, hasPrev: false },
    );

    const ctx = await req();
    (ctx as unknown as { server: { queryCache: unknown } }).server = { queryCache: qc };
    const result = await ctl.list(ctx);

    // Returns stale data immediately
    expect(result.status).toBe(200);
    expect(result.headers?.["x-cache"]).toBe("STALE");

    // Revalidation happens async via scheduleBackground (setImmediate on Node, microtask elsewhere)
    await new Promise((r) => setTimeout(r, 10));
    expect(getAll).toHaveBeenCalled();
    expect(qc.set).toHaveBeenCalled();
  });
});

// ============================================================================
// #5 — bulkUpdate rejects mixed operator/flat shape
// ============================================================================

describe("BaseController hardening — bulkUpdate shape discipline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects { $set: {...}, name: 'x' } with MIXED_UPDATE_SHAPE", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const updateMany = vi.fn();
    const ctl = new BaseController(createMockRepo({ updateMany }), { resourceName: "product" });

    const result = await ctl.bulkUpdate(
      await req({
        filter: { status: "draft" },
        data: { $set: { status: "published" }, name: "leaked-flat-key" },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect((result as { details?: { code?: string } }).details?.code).toBe("MIXED_UPDATE_SHAPE");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accepts pure operator shape", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const updateMany = vi.fn().mockResolvedValue({ matchedCount: 3, modifiedCount: 3 });
    const ctl = new BaseController(createMockRepo({ updateMany }), { resourceName: "product" });

    const result = await ctl.bulkUpdate(
      await req({
        filter: { tag: "a" },
        data: { $set: { tag: "b" }, $inc: { count: 1 } },
      }),
    );

    expect(result.success).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("accepts pure flat shape", async () => {
    const { BaseController } = await import("../../src/core/BaseController.js");
    const updateMany = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const ctl = new BaseController(createMockRepo({ updateMany }), { resourceName: "product" });

    const result = await ctl.bulkUpdate(
      await req({ filter: { id: "x" }, data: { name: "y", price: 10 } }),
    );

    expect(result.success).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects mixed shape even when all flat keys are protected (fail-early)", async () => {
    // If we sanitized first, flat keys might get stripped and we'd miss the
    // shape violation. Shape check runs BEFORE sanitization to surface the bug.
    const { BaseController } = await import("../../src/core/BaseController.js");
    const updateMany = vi.fn();
    const ctl = new BaseController(createMockRepo({ updateMany }), {
      resourceName: "product",
      schemaOptions: { systemFields: ["_id", "createdAt"] },
    });

    const result = await ctl.bulkUpdate(
      await req({
        filter: { id: "x" },
        // _id is a system field → would be stripped; still mixed shape though
        data: { $set: { ok: true }, _id: "nope" },
      }),
    );

    expect(result.status).toBe(400);
    expect((result as { details?: { code?: string } }).details?.code).toBe("MIXED_UPDATE_SHAPE");
  });
});
