/**
 * `createReplayHub` — resumable SSE over a repo-core `ChangeLogStore`.
 *
 * Pins the shared wire contract (ready → replay | one resync → buffer → live),
 * partitioned tailing, revalidation, revoke (local and cross-replica), the
 * `sseStats` gauge and `lastEventIdOf`.
 */
import { CursorExpiredError, MemoryChangeLogStore, STREAM_FRAMES } from "@classytic/repo-core/sync";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import ssePlugin from "../../src/plugins/sse.js";
import {
  createReplayHub,
  lastEventIdOf,
  type ReplayHubOptions,
} from "../../src/utils/replayStream.js";
import { createSseConnectionGauge } from "../../src/utils/sseStats.js";
import { openSseStream, type SseStream } from "../../src/utils/sseStream.js";

// ---------------------------------------------------------------- doubles

interface Frame {
  event: string;
  data: unknown;
  id?: string;
}

function fakeStream() {
  const frames: Frame[] = [];
  /** Id-only frames (`writeId`), in order. */
  const ids: string[] = [];
  const cleanups: Array<() => void> = [];
  let closed = false;
  let full = false;
  const stream = {
    frames,
    ids,
    get closed() {
      return closed;
    },
    fill() {
      full = true;
    },
    write(event: string, data: string, id?: string) {
      if (closed) return false;
      if (full) {
        stream.close();
        return false;
      }
      frames.push({ event, data: JSON.parse(data), ...(id !== undefined ? { id } : {}) });
      return true;
    },
    writeId(id: string) {
      if (closed) return false;
      ids.push(id);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const fn of cleanups) fn();
    },
    onCleanup(fn: () => void) {
      cleanups.push(fn);
    },
  };
  return stream as typeof stream & SseStream;
}

function manualTimers() {
  const live = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    live,
    setInterval: (fn: () => void, ms: number) => {
      const id = next++;
      live.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id: unknown) => {
      live.delete(id as number);
    },
    fire(ms?: number) {
      for (const t of [...live.values()]) if (ms === undefined || t.ms === ms) t.fn();
    },
  };
}

/** A tiny shared bus standing in for arc's events facade on two replicas. */
function memoryBus() {
  const handlers = new Map<string, Set<(e: { type: string; payload: unknown }) => void>>();
  return {
    async publish(type: string, payload: unknown) {
      for (const h of handlers.get(type) ?? []) h({ type, payload });
    },
    async subscribe(pattern: string, h: (e: { type: string; payload: unknown }) => void) {
      const set = handlers.get(pattern) ?? new Set();
      set.add(h);
      handlers.set(pattern, set);
      return () => set.delete(h);
    },
  };
}

const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

interface Ctx {
  user: string;
  tenant?: string;
  session?: string;
}
interface Doc {
  text: string;
  secret?: boolean;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup(
  overrides: Partial<ReplayHubOptions<Doc, Ctx>> = {},
  opts: { store?: MemoryChangeLogStore<Doc>; app?: FastifyInstance; ready?: boolean } = {},
) {
  const store = opts.store ?? new MemoryChangeLogStore<Doc>();
  const app = opts.app ?? Fastify({ logger: false });
  if (!opts.app) apps.push(app);
  const timers = manualTimers();
  const hub = createReplayHub<Doc, Ctx>(app, {
    store,
    toFrame: (entry) => ({ event: "alert", data: { id: entry.docId, ...(entry.doc ?? {}) } }),
    pollMs: 0,
    timers,
    ...overrides,
  });
  if (opts.ready !== false) await app.ready();
  const append = (docId: string, text: string, tenantId?: string) =>
    store.append({
      scope: "alerts",
      docId,
      op: "upsert",
      version: 1,
      doc: { text },
      ...(tenantId ? { tenantId } : {}),
    });
  return { store, app, hub, timers, append };
}

const dataFrames = (s: { frames: Frame[] }) => s.frames.filter((f) => f.event === "alert");
const texts = (s: { frames: Frame[] }) => dataFrames(s).map((f) => (f.data as Doc).text);
const SECRET = "replay-hub-test-secret-0123456789";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- tests

describe("STREAM_FRAMES", () => {
  it("pins the wire literals shared with arc-next", () => {
    expect(STREAM_FRAMES).toEqual({
      READY: "ready",
      RESYNC: "resync",
      REVOKED: "revoked",
      RETRY: "retry",
    });
  });
});

describe("createReplayHub — connect and resume", () => {
  it("no Last-Event-ID: ready{cursor: head, resumed: false}, no resync, live frames carry id = cursor", async () => {
    const { hub, append } = await setup();
    const old = await append("a1", "old");
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    expect(s.frames).toEqual([{ event: "ready", data: { cursor: old.cursor, resumed: false } }]);

    const fresh = await append("a2", "new");
    hub.notify();
    await settle();
    expect(s.frames.slice(1)).toEqual([
      { event: "alert", data: { id: "a2", text: "new" }, id: fresh.cursor },
    ]);
    expect(s.frames.some((f) => f.event === "resync")).toBe(false);
  });

  it("resume within the cap: ready{resumed: true}, replay in order, then live", async () => {
    const { hub, append } = await setup();
    const first = await append("a1", "one");
    await append("a2", "two");
    await append("a3", "three");
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, first.cursor);
    expect(s.frames[0]).toMatchObject({ event: "ready", data: { resumed: true } });
    expect(dataFrames(s).map((f) => (f.data as Doc).text)).toEqual(["two", "three"]);

    await append("a4", "four");
    hub.notify();
    await settle();
    expect(dataFrames(s).map((f) => (f.data as Doc).text)).toEqual(["two", "three", "four"]);
  });

  it("an append landing DURING the replay is delivered exactly once", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub, append } = await setup({}, { store });
    const first = await append("a1", "one");
    await append("a2", "two");

    // Slow the replay read: while it is parked, a new row is appended and the tail pulls it.
    const realSince = store.since.bind(store);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let parked = false;
    vi.spyOn(store, "since").mockImplementation(async (cursor, options) => {
      if (cursor === first.cursor && !parked) {
        parked = true;
        await gate;
      }
      return realSince(cursor, options);
    });

    const s = fakeStream();
    const attaching = hub.attach(s, { user: "u1" }, first.cursor);
    await settle();
    await append("a3", "three");
    hub.notify();
    await settle();
    release();
    await attaching;
    await settle();

    expect(dataFrames(s).map((f) => (f.data as Doc).text)).toEqual(["two", "three"]);
  });

  it("a gap larger than maxReplay: ready{resumed:false}, resync{gap_too_large, cursor: head}, then live", async () => {
    const { hub, append } = await setup({ maxReplay: 2 });
    const first = await append("a1", "1");
    await append("a2", "2");
    await append("a3", "3");
    const last = await append("a4", "4");
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, first.cursor);
    expect(s.frames).toEqual([
      { event: "ready", data: { cursor: last.cursor, resumed: false } },
      { event: "resync", data: { cursor: last.cursor, reason: "gap_too_large" } },
    ]);
    await append("a5", "5");
    hub.notify();
    await settle();
    expect(dataFrames(s).map((f) => (f.data as Doc).text)).toEqual(["5"]);
    expect(hub.stats().resyncs).toBe(1);
  });

  it.each([
    ["instanceof", () => new CursorExpiredError("c", "h")],
    ["duck-typed copy", () => Object.assign(new Error("expired"), { name: "CursorExpiredError" })],
  ])("CursorExpiredError (%s) → resync cursor_expired", async (_label, make) => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub, append } = await setup({}, { store });
    const a = await append("a1", "1");
    const realSince = store.since.bind(store);
    vi.spyOn(store, "since").mockImplementation(async (cursor, options) => {
      if (cursor === "stale") throw make();
      return realSince(cursor, options);
    });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, "stale");
    expect(s.frames[1]).toEqual({
      event: "resync",
      data: { cursor: a.cursor, reason: "cursor_expired" },
    });
  });

  it("isValidCursor false → cursor_invalid without reading the store", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub } = await setup({ isValidCursor: (c) => /^\d{16}$/.test(c) }, { store });
    const since = vi.spyOn(store, "since");
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, "not-a-cursor");
    expect(s.frames[1]).toMatchObject({ event: "resync", data: { reason: "cursor_invalid" } });
    expect(since.mock.calls.some(([c]) => c === "not-a-cursor")).toBe(false);
  });

  it("compareCursors: a cursor ahead of head → cursor_invalid", async () => {
    const { hub, append } = await setup({ compareCursors: (a, b) => (a < b ? -1 : a > b ? 1 : 0) });
    await append("a1", "1");
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, "9999999999999999");
    expect(s.frames[1]).toMatchObject({ event: "resync", data: { reason: "cursor_invalid" } });
  });

  it("any other store error closes the stream with no frame", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub } = await setup({}, { store });
    vi.spyOn(store, "since").mockRejectedValue(new Error("db down"));
    const s = fakeStream();
    const sub = await hub.attach(s, { user: "u1" }, null);
    expect(s.closed).toBe(true);
    expect(sub.closed).toBe(true);
    expect(s.frames).toEqual([]);
    expect(hub.stats().subscribers).toBe(0);
  });
});

describe("createReplayHub — per-subscriber frames and partitions", () => {
  it("toFrame null hides one entry; the next is still delivered", async () => {
    const { hub, append } = await setup({
      toFrame: (e) => (e.doc?.text === "hidden" ? null : { event: "alert", data: e.doc }),
    });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    await append("a1", "hidden");
    await append("a2", "shown");
    hub.notify();
    await settle();
    expect(dataFrames(s).map((f) => (f.data as Doc).text)).toEqual(["shown"]);
  });

  it("two contexts receive different frames for one entry", async () => {
    const { hub, append } = await setup({
      toFrame: (e, ctx) => ({ event: "alert", data: { text: e.doc?.text, for: ctx.user } }),
    });
    const a = fakeStream();
    const b = fakeStream();
    await hub.attach(a, { user: "alice" }, null);
    await hub.attach(b, { user: "bob" }, null);
    await append("x", "hi");
    hub.notify();
    await settle();
    expect(dataFrames(a)[0]?.data).toEqual({ text: "hi", for: "alice" });
    expect(dataFrames(b)[0]?.data).toEqual({ text: "hi", for: "bob" });
  });

  it("readScope partitions the tail: tenant B is never pulled for a tenant-A subscriber", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub, append } = await setup(
      { readScope: (ctx) => ({ tenantId: ctx.tenant, scopes: ["alerts"] }) },
      { store },
    );
    const since = vi.spyOn(store, "since");
    const s = fakeStream();
    await hub.attach(s, { user: "u1", tenant: "A" }, null);
    await append("b1", "for B", "B");
    await append("a1", "for A", "A");
    hub.notify();
    await settle();
    expect(dataFrames(s).map((f) => (f.data as Doc).text)).toEqual(["for A"]);
    expect(since.mock.calls.every(([, o]) => o?.tenantId === "A")).toBe(true);
    expect(hub.stats().partitions).toBe(1);
  });

  it("pollMs delivers without notify(); 100 notify() calls cost at most 2 since() calls", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub, append, timers } = await setup({ pollMs: 1000 }, { store });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    await append("a1", "polled");
    timers.fire(1000);
    await settle();
    expect(dataFrames(s)).toHaveLength(1);

    const since = vi.spyOn(store, "since");
    for (let i = 0; i < 100; i++) hub.notify();
    await settle();
    expect(since.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("backpressure (write → false) removes the subscriber", async () => {
    const { hub, append } = await setup();
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    s.fill();
    await append("a1", "x");
    hub.notify();
    await settle();
    expect(s.closed).toBe(true);
    expect(hub.stats().subscribers).toBe(0);
    expect(hub.stats().partitions).toBe(0);
  });
});

describe("createReplayHub — revalidate and revoke", () => {
  it("null → revoked{access_ended} then close; a new ctx is applied; a throw counts and keeps the stream", async () => {
    const verdicts = new Map<string, "deny" | "throw" | "refresh">([
      ["deny", "deny"],
      ["boom", "throw"],
      ["fresh", "refresh"],
    ]);
    const check = vi.fn(async (ctx: Ctx) => {
      const v = verdicts.get(ctx.user);
      if (v === "deny") return null;
      if (v === "throw") throw new Error("grants service down");
      return { ...ctx, session: "rotated" };
    });
    const { hub, timers } = await setup({ revalidate: { everyMs: 4000, check } });
    const denied = fakeStream();
    const broken = fakeStream();
    const fresh = fakeStream();
    await hub.attach(denied, { user: "deny" }, null);
    await hub.attach(broken, { user: "boom" }, null);
    const sub = await hub.attach(fresh, { user: "fresh" }, null);

    timers.fire(4000);
    await settle();

    expect(denied.frames.at(-1)).toEqual({ event: "revoked", data: { reason: "access_ended" } });
    expect(denied.closed).toBe(true);
    expect(broken.closed).toBe(false);
    expect(sub.ctx.session).toBe("rotated");
    expect(hub.stats()).toMatchObject({ revoked: 1, revalidateFailures: 1, subscribers: 2 });
  });

  it("checks never overlap per subscriber, and memo is shared within a tick", async () => {
    let release: () => void = () => {};
    const memos: Array<Map<string, unknown>> = [];
    const check = vi.fn(async (ctx: Ctx, tick: { memo: Map<string, unknown> }) => {
      memos.push(tick.memo);
      if (ctx.user === "slow") await new Promise<void>((r) => (release = r));
      return ctx;
    });
    const { hub, timers } = await setup({ revalidate: { everyMs: 1000, check } });
    await hub.attach(fakeStream(), { user: "slow" }, null);
    await hub.attach(fakeStream(), { user: "quick" }, null);

    timers.fire(1000);
    await settle();
    expect(memos[0]).toBe(memos[1]);

    timers.fire(1000); // slow is still in flight → skipped; quick runs again
    await settle();
    expect(check.mock.calls.filter(([c]) => c.user === "slow")).toHaveLength(1);
    expect(check.mock.calls.filter(([c]) => c.user === "quick")).toHaveLength(2);
    expect(memos[2]).not.toBe(memos[0]);
    release();
    await settle();
  });

  it("revoke(target) closes only matching subscribers, after a revoked frame", async () => {
    const { hub } = await setup({
      identify: (ctx) => ({ userId: ctx.user, sessionId: ctx.session ?? "" }),
    });
    const a = fakeStream();
    const b = fakeStream();
    const c = fakeStream();
    await hub.attach(a, { user: "u1", session: "s1" }, null);
    await hub.attach(b, { user: "u1", session: "s2" }, null);
    await hub.attach(c, { user: "u2", session: "s3" }, null);

    expect(await hub.revoke({ userId: "u1", sessionId: "s1" })).toBe(1);
    expect(a.frames.at(-1)).toEqual({ event: "revoked", data: { reason: "revoked" } });
    expect([a.closed, b.closed, c.closed]).toEqual([true, false, false]);

    expect(await hub.revoke({ userId: "u1" }, "password_changed")).toBe(1);
    expect(b.frames.at(-1)).toEqual({ event: "revoked", data: { reason: "password_changed" } });
    expect(c.closed).toBe(false);
  });

  it("revokeVia closes a subscriber on a second replica; the wire carries neither ids nor the reason", async () => {
    const bus = memoryBus();
    const published: unknown[] = [];
    const tap = {
      ...bus,
      publish: async (t: string, p: unknown) => {
        published.push(p);
        await bus.publish(t, p);
      },
    };
    const store = new MemoryChangeLogStore<Doc>();
    const identify = (ctx: Ctx) => ({ userId: ctx.user });
    const mk = async () => {
      const app = Fastify({ logger: false });
      apps.push(app);
      app.decorate("events", tap as never);
      return setup({ identify, revokeVia: { secret: SECRET } }, { store, app });
    };
    const one = await mk();
    const two = await mk();
    const local = fakeStream();
    const remote = fakeStream();
    await one.hub.attach(local, { user: "u9" }, null);
    await two.hub.attach(remote, { user: "u9" }, null);

    expect(await one.hub.revoke({ userId: "u9" }, "suspended_for_fraud")).toBe(1);
    await settle();
    expect(local.closed).toBe(true);
    expect(remote.closed).toBe(true);
    expect(remote.frames.at(-1)).toEqual({
      event: "revoked",
      data: { reason: "suspended_for_fraud" },
    });
    // Deterministic (a substring check on random ciphertext failed by chance about 1 run in 20): the wire is ONE opaque
    // sealed blob and nothing beside it; the id and the reason are only inside it, encrypted under the shared secret.
    expect(published).toHaveLength(1);
    const [payload] = published as Array<{ v: number; sealed: string }>;
    expect(Object.keys(payload ?? {}).sort()).toEqual(["sealed", "v"]);
    expect(payload?.v).toBe(1);
    const raw = Buffer.from(payload?.sealed ?? "", "base64");
    expect(raw.toString("base64")).toBe(payload?.sealed); // canonical base64 of binary: no readable text tucked in
    const { createDecipheriv, createHash, hkdfSync } = await import("node:crypto");
    // Opened with the documented construction (AES-256-GCM, HKDF-SHA256 of the secret; `iv(12) | tag(16) | body`).
    const key = Buffer.from(hkdfSync("sha256", SECRET, "", "arc.realtime.revoke/v1", 32));
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    expect(JSON.parse(plain.toString("utf8"))).toMatchObject({
      reason: "suspended_for_fraud",
      keys: { userId: "u9" },
    });
    expect(raw.length).toBe(28 + plain.length);
    expect(raw.subarray(28).equals(plain)).toBe(false); // the body is ciphertext, not the message
    // Not a plain digest either: a guessed id cannot be confirmed by hashing it.
    expect(raw.includes(createHash("sha256").update("u9").digest())).toBe(false);
  });

  it("revokeVia: a replica with another secret ignores the broadcast", async () => {
    const bus = memoryBus();
    const store = new MemoryChangeLogStore<Doc>();
    const identify = (ctx: Ctx) => ({ userId: ctx.user });
    const mk = async (secret: string) => {
      const app = Fastify({ logger: false });
      apps.push(app);
      app.decorate("events", bus as never);
      return setup({ identify, revokeVia: { secret } }, { store, app });
    };
    const one = await mk(SECRET);
    const two = await mk("another-secret-of-enough-length");
    const remote = fakeStream();
    await two.hub.attach(remote, { user: "u9" }, null);
    await one.hub.revoke({ userId: "u9" });
    await settle();
    expect(remote.closed).toBe(false);
  });

  it("revoke compares String(value): an identify returning numbers or ObjectIds still matches", async () => {
    const oid = { toString: () => "65f0c0ffee" };
    const { hub } = await setup({
      identify: (ctx) =>
        ({ userId: Number(ctx.user), orgId: oid }) as unknown as Record<string, string>,
    });
    const s = fakeStream();
    await hub.attach(s, { user: "42" }, null);
    expect(await hub.revoke({ userId: "42", orgId: "65f0c0ffee" })).toBe(1);
    expect(s.closed).toBe(true);
  });

  it("revokeVia without the events plugin fails at ready", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    createReplayHub(app, {
      store: new MemoryChangeLogStore(),
      toFrame: () => null,
      revokeVia: { secret: SECRET },
    });
    await expect(app.ready()).rejects.toThrow(/events plugin/);
  });
});

describe("createReplayHub — exactly once, liveness and scope", () => {
  /** Park the first `since(cursor)` call for `cursor`; `release()` lets it read. */
  function parkSince(store: MemoryChangeLogStore<Doc>, match: (cursor: string) => boolean) {
    const realSince = store.since.bind(store);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let parked = false;
    const spy = vi.spyOn(store, "since").mockImplementation(async (cursor, options) => {
      if (match(cursor) && !parked) {
        parked = true;
        await gate;
      }
      return realSince(cursor, options);
    });
    return { release: () => release(), spy };
  }

  it.each([
    ["opaque cursors (skip set)", {}],
    ["compareCursors (floor)", { compareCursors: cmp }],
  ])(
    "%s: an append during the replay read, tailed AFTER the flush, is sent once",
    async (_label, extra) => {
      const store = new MemoryChangeLogStore<Doc>();
      const { hub, append, timers } = await setup({ pollMs: 1000, ...extra }, { store });
      const first = await append("a1", "one");
      await append("a2", "two");
      const { release } = parkSince(store, (c) => c === first.cursor);

      const s = fakeStream();
      const attaching = hub.attach(s, { user: "u1" }, first.cursor);
      await settle();
      // Another replica appends while the replay read is parked; no notify() arrives.
      await append("a3", "three");
      release();
      await attaching;
      expect(texts(s)).toEqual(["two", "three"]);

      // The poll tails a3 (after head) — it must not go out a second time.
      timers.fire(1000);
      await settle();
      await append("a4", "four");
      timers.fire(1000);
      await settle();
      expect(texts(s)).toEqual(["two", "three", "four"]);
    },
  );

  it("a poll or notify before the partition's head is known never reads the log from the start", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub, append, timers } = await setup({ pollMs: 1000 }, { store });
    for (let i = 0; i < 5; i++) await append(`old${i}`, "old");
    const realLatest = store.latestCursor.bind(store);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(store, "latestCursor").mockImplementation(async (o) => {
      await gate;
      return realLatest(o);
    });
    const since = vi.spyOn(store, "since");

    const s = fakeStream();
    const attaching = hub.attach(s, { user: "u1" }, null);
    await settle();
    hub.notify();
    timers.fire(1000);
    await settle();
    expect(since.mock.calls.some(([c]) => c === "")).toBe(false);
    release();
    await attaching;
    expect(since.mock.calls.some(([c]) => c === "")).toBe(false);
    expect(dataFrames(s)).toEqual([]);
  });

  it("a new connection joins within two page reads under sustained writes", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub, append } = await setup({}, { store });
    await append("seed", "seed");
    const live = fakeStream();
    await hub.attach(live, { user: "u0" }, null);

    // Every tail read sees a new write and a new wake, for a long time.
    const realSince = store.since.bind(store);
    let writes = 0;
    const since = vi.spyOn(store, "since").mockImplementation(async (cursor, options) => {
      const page = await realSince(cursor, options);
      // One store round trip per macrotask, like a real database.
      await new Promise<void>((r) => setImmediate(r));
      if (writes < 200) {
        writes++;
        await append(`w${writes}`, "w");
        hub.notify();
      }
      return page;
    });
    hub.notify();
    await settle(2);

    const callsBefore = since.mock.calls.length;
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    expect(s.frames[0]?.event).toBe("ready");
    expect(since.mock.calls.length - callsBefore).toBeLessThanOrEqual(3);
    expect(writes).toBeLessThan(200);
  });

  it("entries hidden from a subscriber advance its client cursor with an id-only frame", async () => {
    const { hub, append } = await setup({
      maxReplay: 3,
      toFrame: (e) => (e.doc?.text === "hidden" ? null : { event: "alert", data: e.doc }),
    });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    for (let i = 0; i < 6; i++) await append(`h${i}`, "hidden");
    const last = await append("h6", "hidden");
    hub.notify();
    await settle();
    expect(dataFrames(s)).toEqual([]);
    expect(s.ids).toEqual([last.cursor]);

    // A reconnect from that checkpoint replays nothing instead of `gap_too_large`.
    const again = fakeStream();
    await hub.attach(again, { user: "u1" }, s.ids.at(-1) ?? null);
    expect(again.frames).toEqual([
      { event: "ready", data: { cursor: last.cursor, resumed: true } },
    ]);

    // A visible entry after hidden ones needs no checkpoint: its own id moves the cursor.
    await append("h7", "hidden");
    await append("v1", "shown");
    hub.notify();
    await settle();
    expect(s.ids).toHaveLength(1);
    expect(texts(s)).toEqual(["shown"]);
  });

  it("a revalidation that moves the ctx to another scope DURING attach closes the stream", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const { hub, timers } = await setup(
      {
        readScope: (ctx) => ({ tenantId: ctx.tenant }),
        revalidate: { everyMs: 1000, check: async (ctx) => ({ ...ctx, tenant: "B" }) },
      },
      { store },
    );
    const realLatest = store.latestCursor.bind(store);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(store, "latestCursor").mockImplementation(async (o) => {
      await gate;
      return realLatest(o);
    });
    const s = fakeStream();
    const attaching = hub.attach(s, { user: "u1", tenant: "A" }, null);
    await settle();
    timers.fire(1000);
    await settle();
    release();
    const sub = await attaching;
    expect(s.closed).toBe(true);
    expect(sub.closed).toBe(true);
    expect(s.frames).toEqual([]);
    expect(hub.stats()).toMatchObject({ subscribers: 0, partitions: 0 });
  });

  it.each([
    ["undefined", undefined],
    ["false", false],
  ])("revalidate returning %s fails closed (revoked)", async (_label, verdict) => {
    const { hub, timers } = await setup({
      revalidate: { everyMs: 1000, check: async () => verdict as unknown as Ctx },
    });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    timers.fire(1000);
    await settle();
    expect(s.frames.at(-1)).toEqual({ event: "revoked", data: { reason: "access_ended" } });
    expect(s.closed).toBe(true);
  });
});

describe("sseStats and lifecycle", () => {
  it("sseStats sums the hub, a custom-route gauge and ssePlugin", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(eventPlugin);
    await app.register(ssePlugin, { requireAuth: false });
    const gauge = createSseConnectionGauge(app);
    const { hub } = await setup({}, { app });

    await hub.attach(fakeStream(), { user: "u1" }, null);
    await hub.attach(fakeStream(), { user: "u2" }, null);
    const custom = fakeStream();
    gauge.track(custom);
    gauge.track(custom); // idempotent
    expect(app.sseStats()).toEqual({ connections: 3, keys: 0 });
    custom.close();
    expect(app.sseStats().connections).toBe(2);
  });

  it("close() closes every stream and clears every timer; app.close() runs it", async () => {
    const { hub, timers, app } = await setup({
      pollMs: 500,
      revalidate: { everyMs: 1000, check: async (c) => c },
    });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    expect(timers.live.size).toBe(2);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(s.closed).toBe(true);
    expect(timers.live.size).toBe(0);
    expect(hub.stats()).toMatchObject({ subscribers: 0, partitions: 0 });
    // A late attach on a closed hub closes immediately.
    const late = fakeStream();
    expect((await hub.attach(late, { user: "u2" }, null)).closed).toBe(true);
  });

  it("timers stop when the last subscriber leaves", async () => {
    const { hub, timers } = await setup({ pollMs: 500 });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    expect(timers.live.size).toBe(1);
    s.close();
    expect(timers.live.size).toBe(0);
  });

  it("rejects invalid options", () => {
    const app = Fastify({ logger: false });
    const base = { store: new MemoryChangeLogStore(), toFrame: () => null };
    expect(() => createReplayHub(app, { ...base, maxReplay: -1 })).toThrow(/maxReplay/);
    expect(() => createReplayHub(app, { ...base, pollMs: -5 })).toThrow(/pollMs/);
    expect(() =>
      createReplayHub(app, { ...base, revalidate: { everyMs: 0, check: async () => null } }),
    ).toThrow(/everyMs/);
    expect(() => createReplayHub(app, { ...base, revokeVia: { secret: "short" } })).toThrow(
      /revokeVia\.secret/,
    );
    expect(() =>
      createReplayHub(app, { ...base, revokeVia: {} as unknown as { secret: string } }),
    ).toThrow(/revokeVia\.secret/);
    expect(() =>
      createReplayHub(app, {
        ...base,
        revalidate: { everyMs: 1000, check: async () => null, maxConsecutiveFailures: 0 },
      }),
    ).toThrow(/maxConsecutiveFailures/);
  });
});

describe("createReplayHub — revalidate close verdicts (retry / revoke with a reason)", () => {
  it("{ close: 'revoke', reason } → revoked{reason} and close; no reason → access_ended", async () => {
    const check = vi.fn(async (ctx: Ctx) =>
      ctx.user === "mfa"
        ? { close: "revoke" as const, reason: "mfa_required" }
        : { close: "revoke" as const },
    );
    const { hub, timers } = await setup({ revalidate: { everyMs: 1000, check } });
    const mfa = fakeStream();
    const plain = fakeStream();
    await hub.attach(mfa, { user: "mfa" }, null);
    await hub.attach(plain, { user: "plain" }, null);
    timers.fire(1000);
    await settle();
    expect(mfa.frames.at(-1)).toEqual({ event: "revoked", data: { reason: "mfa_required" } });
    expect(plain.frames.at(-1)).toEqual({ event: "revoked", data: { reason: "access_ended" } });
    expect(mfa.closed && plain.closed).toBe(true);
    expect(hub.stats()).toMatchObject({ revoked: 2, retried: 0, subscribers: 0 });
  });

  it("{ close: 'retry', reason } → a non-final retry{reason} frame, then close (no revoked)", async () => {
    const check = vi.fn(async () => ({ close: "retry" as const, reason: "session_unconfirmed" }));
    const { hub, timers } = await setup({ revalidate: { everyMs: 1000, check } });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    timers.fire(1000);
    await settle();
    expect(s.frames.at(-1)).toEqual({
      event: STREAM_FRAMES.RETRY,
      data: { reason: "session_unconfirmed" },
    });
    expect(s.frames.some((f) => f.event === "revoked")).toBe(false);
    expect(s.closed).toBe(true);
    expect(hub.stats()).toMatchObject({ retried: 1, revoked: 0, subscribers: 0 });
  });

  it("maxConsecutiveFailures: the Nth throw in a row closes with retry{revalidate_failed}; a success resets the count", async () => {
    const outcomes: Array<"throw" | "ok"> = ["throw", "throw", "ok", "throw", "throw", "throw"];
    const check = vi.fn(async (ctx: Ctx) => {
      if (outcomes.shift() === "throw") throw new Error("session store unreachable");
      return ctx;
    });
    const { hub, timers } = await setup({
      revalidate: { everyMs: 1000, check, maxConsecutiveFailures: 3 },
    });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    for (let i = 0; i < 5; i++) {
      timers.fire(1000);
      await settle();
      expect(s.closed, `still open after check ${i + 1}`).toBe(false);
    }
    timers.fire(1000);
    await settle();
    expect(s.frames.at(-1)).toEqual({ event: "retry", data: { reason: "revalidate_failed" } });
    expect(s.closed).toBe(true);
    expect(hub.stats()).toMatchObject({ revalidateFailures: 5, retried: 1, revoked: 0 });
  });

  it("without maxConsecutiveFailures a throw still keeps the stream, however many in a row", async () => {
    const check = vi.fn(async () => {
      throw new Error("down");
    });
    const { hub, timers } = await setup({ revalidate: { everyMs: 1000, check } });
    const s = fakeStream();
    await hub.attach(s, { user: "u1" }, null);
    for (let i = 0; i < 10; i++) {
      timers.fire(1000);
      await settle();
    }
    expect(s.closed).toBe(false);
    expect(hub.stats()).toMatchObject({ revalidateFailures: 10, retried: 0 });
  });

  it("a ctx that carries a `close` field is a ctx, not a verdict", async () => {
    type Closable = Ctx & { close?: string };
    const check = vi.fn(async (ctx: Closable) => ({ ...ctx, close: "retry", session: "s2" }));
    const store = new MemoryChangeLogStore<Doc>();
    const app = Fastify({ logger: false });
    apps.push(app);
    const timers = manualTimers();
    const hub = createReplayHub<Doc, Closable>(app, {
      store,
      toFrame: () => null,
      pollMs: 0,
      timers,
      revalidate: { everyMs: 1000, check },
    });
    await app.ready();
    const s = fakeStream();
    const sub = await hub.attach(s, { user: "u1" }, null);
    timers.fire(1000);
    await settle();
    expect(s.closed).toBe(false);
    expect(sub.ctx).toMatchObject({ session: "s2", close: "retry" });
  });
});

describe("openSseStream.writeId", () => {
  it("writes an id-only frame (no data) and honours backpressure (fail-fast budget)", () => {
    const chunks: string[] = [];
    let accept = true;
    const listeners: Array<() => void> = [];
    const reply = {
      hijack() {},
      getHeaders: () => ({}),
      raw: {
        writableEnded: false,
        writeHead() {},
        flushHeaders() {},
        write(chunk: string) {
          chunks.push(chunk);
          return accept;
        },
        end() {
          reply.raw.writableEnded = true;
        },
      },
    };
    const request = {
      raw: { on: (_e: string, fn: () => void) => listeners.push(fn), destroy() {} },
    };
    const stream = openSseStream(request as never, reply as never, {
      heartbeatMs: 60_000,
      maxBufferedBytes: 0,
    });
    expect(stream.writeId?.("0000000000000007")).toBe(true);
    expect(chunks.at(-1)).toBe("id: 0000000000000007\n\n");
    accept = false;
    expect(stream.writeId?.("0000000000000008")).toBe(false);
    expect(stream.writeId?.("0000000000000009")).toBe(false);
    expect(reply.raw.writableEnded).toBe(true);
  });
});

describe("lastEventIdOf", () => {
  const req = (headers: Record<string, unknown>, query: Record<string, unknown> = {}) =>
    ({ headers, query }) as unknown as FastifyRequest;

  it("prefers the header, falls back to the query parameter", () => {
    expect(lastEventIdOf(req({ "last-event-id": "0001" }, { lastEventId: "0002" }))).toBe("0001");
    expect(lastEventIdOf(req({}, { lastEventId: "0002" }))).toBe("0002");
    expect(lastEventIdOf(req({}, { since: "0003" }), { queryParam: "since" })).toBe("0003");
    expect(lastEventIdOf(req({}, { lastEventId: "0002" }), { queryParam: null })).toBeNull();
    expect(lastEventIdOf(req({}))).toBeNull();
  });

  it("takes the first value of an array header", () => {
    expect(lastEventIdOf(req({ "last-event-id": ["0005", "0006"] }))).toBe("0005");
  });

  it("rejects empty, oversized and control-character values", () => {
    expect(lastEventIdOf(req({ "last-event-id": "" }))).toBeNull();
    expect(lastEventIdOf(req({ "last-event-id": "x".repeat(257) }))).toBeNull();
    expect(lastEventIdOf(req({ "last-event-id": "x".repeat(256) }))).toBe("x".repeat(256));
    expect(lastEventIdOf(req({ "last-event-id": "abc\ndef" }))).toBeNull();
    expect(lastEventIdOf(req({}, { lastEventId: "a\u0000b" }))).toBeNull();
  });
});
