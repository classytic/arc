/**
 * Wave-12 performance: cache-fill single-flight in BaseCrudController.
 *
 * A popular cache entry expiring under N concurrent readers must produce
 * ONE repository query, not N (cache stampede). Coalescing is keyed on the
 * full cache key (query + user/org scope + resource version), so it can
 * never cross tenants or invalidation generations.
 *
 * Covers:
 *   - concurrent MISS readers coalesce onto one repo query + one cache set
 *   - a same-tick burst of STALE readers schedules exactly one background
 *     revalidation (synchronous flight registration)
 *   - the flight is cleared after completion — the next miss queries again
 *   - distinct keys do NOT coalesce
 */

import { afterEach, describe, expect, it, vi } from "vitest";

function page(id: string) {
  return { data: [{ _id: id }], total: 1, page: 1, pages: 1, hasNext: false, hasPrev: false };
}

let _HookSystem: new () => unknown;
async function hooks() {
  if (!_HookSystem) {
    _HookSystem = (await import("../../src/hooks/HookSystem.js")).HookSystem;
  }
  return new _HookSystem();
}

async function req(query: Record<string, unknown> = {}, qc?: unknown) {
  return {
    params: {},
    query,
    body: {},
    headers: {},
    user: undefined,
    server: qc ? { queryCache: qc } : undefined,
    metadata: { arc: { hooks: await hooks() } },
  };
}

/** Minimal QueryCache stub with a scriptable status. */
function makeQc(status: "miss" | "stale", staleData?: unknown) {
  return {
    getResourceVersion: vi.fn(async () => 1),
    get: vi.fn(async () =>
      status === "miss"
        ? { data: undefined, status: "miss" as const }
        : { data: staleData, status: "stale" as const },
    ),
    set: vi.fn(async () => {}),
  };
}

async function makeController(getAll: (...args: unknown[]) => Promise<unknown>) {
  const { BaseController } = await import("../../src/core/BaseController.js");
  const repo = {
    getAll: vi.fn(getAll),
    getById: vi.fn(async () => null),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const ctl = new BaseController(repo, {
    resourceName: "product",
    cache: { staleTime: 60, gcTime: 300 },
  });
  return { ctl, repo };
}

describe("BaseCrudController — cache-fill single-flight", () => {
  afterEach(() => vi.restoreAllMocks());

  it("coalesces concurrent MISS readers onto ONE repo query and one cache write", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const { ctl, repo } = await makeController(async () => {
      await gate;
      return page("fresh");
    });
    const qc = makeQc("miss");

    const readers = Promise.all(
      Array.from({ length: 25 }, async () => ctl.list(await req({}, qc))),
    );
    // Let every reader pass qc.get and reach the single-flight gate.
    await new Promise((r) => setTimeout(r, 10));
    release(undefined);
    const results = await readers;

    expect(repo.getAll).toHaveBeenCalledTimes(1);
    expect(qc.set).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.headers?.["x-cache"]).toBe("MISS");
      expect((result as { data: ReturnType<typeof page> }).data.data[0]?._id).toBe("fresh");
    }
  });

  it("schedules exactly ONE background revalidation for a burst of STALE readers", async () => {
    const { ctl, repo } = await makeController(async () => page("fresh"));
    const qc = makeQc("stale", page("stale"));

    const results = await Promise.all(
      Array.from({ length: 25 }, async () => ctl.list(await req({}, qc))),
    );
    for (const result of results) {
      expect(result.headers?.["x-cache"]).toBe("STALE");
    }

    // Background refresh runs via scheduleBackground (setImmediate/microtask).
    await new Promise((r) => setTimeout(r, 20));
    expect(repo.getAll).toHaveBeenCalledTimes(1);
    expect(qc.set).toHaveBeenCalledTimes(1);
  });

  it("clears the flight after completion — a later miss queries the repo again", async () => {
    const { ctl, repo } = await makeController(async () => page("fresh"));
    const qc = makeQc("miss");

    await ctl.list(await req({}, qc));
    await ctl.list(await req({}, qc));

    expect(repo.getAll).toHaveBeenCalledTimes(2);
  });

  it("does NOT coalesce distinct cache keys", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const { ctl, repo } = await makeController(async () => {
      await gate;
      return page("fresh");
    });
    const qc = makeQc("miss");

    // Different query params → different cache keys → independent flights.
    const readers = Promise.all([
      ctl.list(await req({ status: "active" }, qc)),
      ctl.list(await req({ status: "archived" }, qc)),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    release(undefined);
    await readers;

    expect(repo.getAll).toHaveBeenCalledTimes(2);
  });
});
