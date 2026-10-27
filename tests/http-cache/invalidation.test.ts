import { createEvent } from "@classytic/primitives/events";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import {
  type CachePurger,
  composePurgers,
  createMemoryPurger,
  type HttpCacheOptions,
  httpCachePlugin,
  tagsForCrudEvent,
} from "../../src/http-cache/index.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close().catch(() => {});
  app = null;
});

async function boot(
  opts: HttpCacheOptions,
  withEvents = false,
  routes?: (a: FastifyInstance) => void,
) {
  const a = Fastify({ logger: false });
  if (withEvents) await a.register(eventPlugin);
  await a.register(httpCachePlugin, { batchWindowMs: 60_000, ...opts });
  routes?.(a);
  await a.ready();
  app = a;
  return a;
}

describe("batching", () => {
  it("de-duplicates tags within a window into one call", async () => {
    const { purger, calls } = createMemoryPurger();
    const a = await boot({ purger });
    a.httpCache.invalidate(["catalog", "course:1"]);
    a.httpCache.invalidate("catalog");
    a.httpCache.invalidate(["course:2", "bad tag"]);
    expect(a.httpCache.pending().sort()).toEqual(["catalog", "course:1", "course:2"]);
    await a.httpCache.flush();
    expect(calls).toEqual([{ tags: ["catalog", "course:1", "course:2"], mode: "hard" }]);
    expect(a.httpCache.pending()).toEqual([]);
  });

  it("sends the batch when the window closes", async () => {
    const { purger, calls } = createMemoryPurger();
    const a = await boot({ purger, batchWindowMs: 5 });
    a.httpCache.invalidate("catalog");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it("splits to the purger's per-call limit", async () => {
    const { purger, calls } = createMemoryPurger({ maxTagsPerCall: 2 });
    const a = await boot({ purger });
    a.httpCache.invalidate(["a", "b", "c", "d", "e"]);
    await a.httpCache.flush();
    expect(calls.map((c) => c.tags)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("sends soft and hard separately to a soft-capable purger; hard wins for a tag queued both ways", async () => {
    const { purger, calls } = createMemoryPurger({ softPurge: true });
    const a = await boot({ purger });
    a.httpCache.invalidate(["x", "y"], { mode: "soft" });
    a.httpCache.invalidate(["y", "z"], { mode: "hard" });
    await a.httpCache.flush();
    expect(calls).toEqual([
      { tags: ["y", "z"], mode: "hard" },
      { tags: ["x"], mode: "soft" },
    ]);
  });

  it("sends everything hard to a purger without soft purge", async () => {
    const { purger, calls } = createMemoryPurger({ softPurge: false });
    const a = await boot({ purger });
    a.httpCache.invalidate(["x"], { mode: "soft" });
    await a.httpCache.flush();
    expect(calls).toEqual([{ tags: ["x"], mode: "hard" }]);
  });

  it("reports a failed purge, counts it, and never throws to the caller", async () => {
    const onPurge = vi.fn();
    const purger: CachePurger = {
      name: "down",
      purgeTags: async () => Promise.reject(new Error("cdn down")),
    };
    const a = await boot({ purger, observer: { onPurge } });
    a.httpCache.invalidate("catalog");
    await expect(a.httpCache.flush()).resolves.toBeUndefined();
    expect(onPurge).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", tags: ["catalog"], delivery: "batched" }),
    );
    expect(a.httpCache.stats().purges).toMatchObject({ failed: 1, sent: 0 });
  });

  it("flushes pending invalidations on close", async () => {
    const { purger, calls } = createMemoryPurger();
    const a = await boot({ purger });
    a.httpCache.invalidate("catalog");
    await a.close();
    app = null;
    expect(calls).toHaveLength(1);
  });
});

describe("composePurgers", () => {
  it("purges every tier with its own chunking and soft support, and reports every failure", async () => {
    const cdn = createMemoryPurger({ softPurge: true, maxTagsPerCall: 1 });
    const local = createMemoryPurger({ softPurge: false });
    const both = composePurgers(cdn.purger, local.purger);
    await both.purgeTags(["a", "b"], { mode: "soft" });
    expect(cdn.calls).toEqual([
      { tags: ["a"], mode: "soft" },
      { tags: ["b"], mode: "soft" },
    ]);
    expect(local.calls).toEqual([{ tags: ["a", "b"], mode: "hard" }]);

    const broken: CachePurger = {
      name: "broken",
      purgeTags: async () => Promise.reject(new Error("x")),
    };
    const ok = createMemoryPurger();
    await expect(
      composePurgers(broken, ok.purger).purgeTags(["a"], { mode: "hard" }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(ok.calls).toHaveLength(1);
  });
});

describe("sources", () => {
  const resources = new Map([
    ["course", { extra: (doc: unknown) => [`org:${(doc as { org?: string })?.org}`] }],
  ]);
  const crud = (type: string, id?: string, data?: unknown) =>
    createEvent(type, { data }, {
      resource: type.split(".")[0]!.replace(/^.*:/, ""),
      ...(id ? { resourceId: id } : {}),
    } as never);

  it("derives tags and mode from CRUD events of cached resources only", () => {
    expect(tagsForCrudEvent(crud("course.updated", "c1", { org: "o1" }), resources)).toEqual({
      tags: ["course", "course:c1", "org:o1"],
      mode: "soft",
    });
    expect(tagsForCrudEvent(crud("course.deleted", "c1", {}), resources)?.mode).toBe("hard");
    expect(tagsForCrudEvent(crud("order.updated", "o1", {}), resources)).toBeUndefined();
    expect(tagsForCrudEvent(crud("course.archived", "c1", {}), resources)).toBeUndefined();
  });

  it("resolves a namespaced event to its bare resource", () => {
    const event = createEvent("lms:course.updated", { data: {} }, { resourceId: "c2" } as never);
    expect(tagsForCrudEvent(event, resources)?.tags).toEqual(
      expect.arrayContaining(["course", "course:c2"]),
    );
  });

  it("purges automatically from CRUD events of a resource whose route declared httpCache", async () => {
    const { purger, calls } = createMemoryPurger({ softPurge: true });
    const a = await boot({ purger }, true, (x) => {
      x.get(
        "/courses/:id",
        { config: { httpCache: { cdn: 60, resource: { name: "course", op: "get" } } } },
        async () => ({}),
      );
    });
    await a.events.publish(
      "course.updated",
      { data: {} },
      { resource: "course", resourceId: "c9" },
    );
    await a.events.publish("order.updated", { data: {} }, { resource: "order", resourceId: "o1" });
    await a.httpCache.flush();
    expect(calls).toEqual([{ tags: ["course", "course:c9"], mode: "soft" }]);
  });

  it("purges from explicit purgeOn patterns", async () => {
    const { purger, calls } = createMemoryPurger();
    const a = await boot(
      {
        purger,
        purgeOn: { "lesson.*": (e) => [`course:${(e.payload as { courseId: string }).courseId}`] },
      },
      true,
    );
    await a.events.publish("lesson.updated", { courseId: "c3" });
    await a.httpCache.flush();
    expect(calls).toEqual([{ tags: ["course:c3"], mode: "hard" }]);
  });

  it("can turn automatic purges off", async () => {
    const { purger, calls } = createMemoryPurger();
    const a = await boot({ purger, autoPurge: false }, true, (x) => {
      x.get(
        "/c/:id",
        { config: { httpCache: { cdn: 60, resource: { name: "course", op: "get" } } } },
        async () => ({}),
      );
    });
    await a.events.publish(
      "course.updated",
      { data: {} },
      { resource: "course", resourceId: "c1" },
    );
    await a.httpCache.flush();
    expect(calls).toEqual([]);
  });
});
