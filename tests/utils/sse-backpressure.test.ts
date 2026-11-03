/**
 * Bounded SSE backpressure (`openSseStream` + `createReplayHub`).
 *
 * Node's `write()` returns `false` as soon as the bytes waiting in a socket pass
 * its writable high-water mark (16 KiB by default). A synchronous burst reaches
 * that on a perfectly fast client, so treating the first `false` as "slow client"
 * destroyed healthy streams: a resumed client with more than ~16 KB of missed
 * frames was cut before `ready`, reconnected with the same `Last-Event-ID`, and
 * was cut again, for ever.
 *
 * Pins: the stream waits for `drain` within a byte budget and a time budget and
 * destroys only past either; `maxBufferedBytes: 0` keeps the old fail-fast rule;
 * the replay hub paces a replay (and a live burst) by `drain`, so a multi-megabyte
 * resume over a real socket arrives whole, in order, exactly once.
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChangeEntry } from "@classytic/repo-core/sync";
import { MemoryChangeLogStore } from "@classytic/repo-core/sync";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplayHub, lastEventIdOf } from "../../src/utils/replayStream.js";
import { openSseStream, type SseStream } from "../../src/utils/sseStream.js";

// ---------------------------------------------------------------- doubles

/** A `reply.raw` stand-in whose buffer the test fills and drains by hand. */
function fakeReply() {
  const raw = Object.assign(new EventEmitter(), {
    chunks: [] as string[],
    accept: true,
    writableLength: 0,
    writableEnded: false,
    writeHead() {},
    flushHeaders() {},
    write(chunk: string) {
      raw.chunks.push(chunk);
      return raw.accept;
    },
    end() {
      raw.writableEnded = true;
    },
  });
  const destroyed: Error[] = [];
  const request = {
    raw: {
      on: () => {},
      destroy: (err: Error) => destroyed.push(err),
    },
  };
  const reply = { hijack() {}, getHeaders: () => ({}), raw };
  return { raw, reply, request, destroyed };
}

const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

interface Frame {
  event: string;
  data: string;
  id?: string;
}

/** A real HTTP client that parses SSE frames as they arrive. */
function sseClient(
  url: string,
  headers: Record<string, string> = {},
  opts: { paused?: boolean } = {},
) {
  const frames: Frame[] = [];
  let ended = false;
  let text = "";
  let res: http.IncomingMessage | undefined;
  const wake = new Set<() => void>();
  const notify = () => {
    for (const fn of [...wake]) fn();
  };
  const parse = () => {
    for (;;) {
      const end = text.indexOf("\n\n");
      if (end < 0) return;
      const block = text.slice(0, end);
      text = text.slice(end + 2);
      const frame: Frame = { event: "message", data: "" };
      let isEvent = false;
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) {
          frame.event = line.slice(7);
          isEvent = true;
        } else if (line.startsWith("data: ")) {
          frame.data = line.slice(6);
          isEvent = true;
        } else if (line.startsWith("id: ")) frame.id = line.slice(4);
      }
      if (isEvent) frames.push(frame);
    }
  };
  const req = http.get(url, { headers }, (r) => {
    res = r;
    r.setEncoding("utf8");
    if (opts.paused) r.pause();
    r.on("data", (chunk: string) => {
      text += chunk;
      parse();
      notify();
    });
    const done = () => {
      ended = true;
      notify();
    };
    r.on("end", done);
    r.on("close", done);
    r.on("error", done);
  });
  req.on("error", () => {
    ended = true;
    notify();
  });
  const waitFor = <T>(get: () => T | undefined, timeoutMs: number) =>
    new Promise<T | undefined>((resolve) => {
      const check = () => {
        const v = get();
        if (v !== undefined) {
          cleanup();
          resolve(v);
        } else if (ended) {
          cleanup();
          resolve(get());
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(get());
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        wake.delete(check);
      };
      wake.add(check);
      check();
    });
  return {
    frames,
    get ended() {
      return ended;
    },
    next: (pred: (f: Frame) => boolean, timeoutMs = 10_000) =>
      waitFor(() => frames.find(pred), timeoutMs),
    ends: (timeoutMs = 10_000) => waitFor(() => (ended ? true : undefined), timeoutMs),
    close() {
      req.destroy();
      res?.destroy();
    },
  };
}

const apps: FastifyInstance[] = [];
const clients: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const app of apps.splice(0)) await app.close();
  vi.useRealTimers();
});

async function listen(app: FastifyInstance): Promise<string> {
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

const pad = (n: number) => "x".repeat(n);

// ---------------------------------------------------------------- openSseStream

describe("openSseStream — bounded backpressure", () => {
  it("a full buffer within the byte budget waits for drain instead of destroying", async () => {
    const { raw, reply, request, destroyed } = fakeReply();
    const stream = openSseStream(request as never, reply as never, { heartbeatMs: 60_000 });
    raw.accept = false;
    raw.writableLength = 20_000;
    expect(stream.write("tick", "{}", "1")).toBe(true);
    expect(stream.write("tick", "{}", "2")).toBe(true);
    expect(stream.needsDrain).toBe(true);
    expect(destroyed).toEqual([]);

    const waiting = stream.drain?.();
    raw.accept = true;
    raw.writableLength = 0;
    raw.emit("drain");
    await expect(waiting).resolves.toBe(true);
    expect(stream.needsDrain).toBe(false);
    await expect(stream.drain?.()).resolves.toBe(true);
    stream.close();
  });

  it("past maxBufferedBytes the connection is destroyed, write answers false, waiters get false", async () => {
    const { raw, reply, request, destroyed } = fakeReply();
    const stream = openSseStream(request as never, reply as never, {
      heartbeatMs: 60_000,
      maxBufferedBytes: 64 * 1024,
    });
    raw.accept = false;
    raw.writableLength = 32 * 1024;
    expect(stream.write("tick", "{}")).toBe(true);
    const waiting = stream.drain?.();
    raw.writableLength = 64 * 1024 + 1;
    expect(stream.write("tick", "{}")).toBe(false);
    expect(destroyed[0]?.message).toMatch(/backpressure/);
    expect(raw.writableEnded).toBe(true);
    await expect(waiting).resolves.toBe(false);
    expect(stream.write("tick", "{}")).toBe(false);
    await expect(stream.drain?.()).resolves.toBe(false);
  });

  it("no drain within drainTimeoutMs destroys the connection; heartbeats wait meanwhile", async () => {
    vi.useFakeTimers();
    const { raw, reply, request, destroyed } = fakeReply();
    const cleanup = vi.fn();
    const stream = openSseStream(request as never, reply as never, {
      heartbeatMs: 100,
      drainTimeoutMs: 1_000,
    });
    stream.onCleanup(cleanup);
    raw.accept = false;
    raw.writableLength = 20_000;
    stream.write("tick", "{}");
    const before = raw.chunks.length;
    vi.advanceTimersByTime(999);
    expect(raw.chunks.length).toBe(before); // no heartbeat behind a full buffer
    expect(destroyed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(destroyed[0]?.message).toMatch(/no drain within 1000 ms/);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("a drain in time cancels the timeout", () => {
    vi.useFakeTimers();
    const { raw, reply, request, destroyed } = fakeReply();
    const stream = openSseStream(request as never, reply as never, {
      heartbeatMs: 60_000,
      drainTimeoutMs: 1_000,
    });
    raw.accept = false;
    stream.write("tick", "{}");
    vi.advanceTimersByTime(500);
    raw.accept = true;
    raw.emit("drain");
    vi.advanceTimersByTime(5_000);
    expect(destroyed).toEqual([]);
    expect(stream.write("tick", "{}")).toBe(true);
    stream.close();
  });

  it("maxBufferedBytes: 0 keeps the fail-fast rule (first full write destroys)", () => {
    const { raw, reply, request, destroyed } = fakeReply();
    const stream = openSseStream(request as never, reply as never, {
      heartbeatMs: 60_000,
      maxBufferedBytes: 0,
    });
    raw.accept = false;
    expect(stream.write("tick", "{}")).toBe(false);
    expect(destroyed).toHaveLength(1);
  });

  it("rejects invalid budgets before taking over the socket", () => {
    const { reply, request } = fakeReply();
    const hijack = vi.spyOn(reply, "hijack");
    expect(() => openSseStream(request as never, reply as never, { maxBufferedBytes: -1 })).toThrow(
      /maxBufferedBytes/,
    );
    expect(() => openSseStream(request as never, reply as never, { drainTimeoutMs: 0 })).toThrow(
      /drainTimeoutMs/,
    );
    expect(hijack).not.toHaveBeenCalled();
  });

  it("over a real socket: a 256 KiB synchronous burst reaches a reading client whole", async () => {
    const app = Fastify({ logger: false });
    const streams: SseStream[] = [];
    app.get("/burst", async (request, reply) => {
      const stream = openSseStream(request, reply, { heartbeatMs: 60_000 });
      streams.push(stream);
      for (let i = 0; i < 256; i++) stream.write("chunk", JSON.stringify({ i, pad: pad(1024) }));
      stream.write("done", "{}");
    });
    const base = await listen(app);
    const client = sseClient(`${base}/burst`);
    clients.push(client);
    expect(await client.next((f) => f.event === "done")).toBeDefined();
    expect(client.frames.filter((f) => f.event === "chunk")).toHaveLength(256);
    expect(client.ended).toBe(false);
    expect(streams[0]?.needsDrain).toBe(false);
  });

  it("over a real socket: one frame larger than maxBufferedBytes reaches a reading client", async () => {
    // The budget judges bytes queued BEFORE a write; counting the frame itself
    // destroyed a fast client on any frame over 1 MiB.
    const app = Fastify({ logger: false });
    app.get("/big", async (request, reply) => {
      const stream = openSseStream(request, reply, { heartbeatMs: 60_000 });
      expect(stream.write("big", JSON.stringify({ pad: pad(1536 * 1024) }), "1")).toBe(true);
      // A pacing writer waits for the frame to drain before the next one.
      if (await stream.drain?.()) stream.write("done", "{}", "2");
    });
    const base = await listen(app);
    const client = sseClient(`${base}/big`);
    clients.push(client);
    expect(await client.next((f) => f.event === "done")).toBeDefined();
    const big = client.frames.find((f) => f.event === "big");
    expect(Buffer.byteLength(big?.data ?? "")).toBeGreaterThan(1024 * 1024);
    expect(client.ended).toBe(false);
  });

  it("over a real socket: a client that stops reading is destroyed within the drain timeout", async () => {
    const app = Fastify({ logger: false });
    let closedAt = 0;
    let stream: SseStream | undefined;
    app.get("/flood", async (request, reply) => {
      stream = openSseStream(request, reply, { heartbeatMs: 60_000, drainTimeoutMs: 300 });
      stream.onCleanup(() => {
        closedAt = Date.now();
      });
      const frame = JSON.stringify({ pad: pad(64 * 1024) });
      // A well-behaved writer: paces itself by drain, so only the TIME budget can end it.
      for (let i = 0; i < 4_000; i++) {
        if (!stream.write("chunk", frame)) return;
        if (stream.needsDrain && !(await stream.drain?.())) return;
      }
    });
    const base = await listen(app);
    const client = sseClient(`${base}/flood`, {}, { paused: true });
    clients.push(client);
    const started = Date.now();
    await vi.waitFor(() => expect(closedAt).toBeGreaterThan(0), { timeout: 20_000 });
    expect(closedAt - started).toBeLessThan(20_000);
    expect(stream?.needsDrain).toBe(false);
  });
});

// ---------------------------------------------------------------- replay hub

interface Doc {
  text: string;
}

/** A stream double that reports a full buffer after `capacity` writes until `release()`. */
function drainingStream(capacity: number) {
  const frames: Array<{ event: string; data: unknown; id?: string }> = [];
  const ids: string[] = [];
  const cleanups: Array<() => void> = [];
  let closed = false;
  let sinceDrain = 0;
  let waiters: Array<(ok: boolean) => void> = [];
  const stream = {
    frames,
    ids,
    drains: 0,
    get closed() {
      return closed;
    },
    get needsDrain() {
      return !closed && sinceDrain >= capacity;
    },
    drain() {
      if (closed) return Promise.resolve(false);
      if (sinceDrain < capacity) return Promise.resolve(true);
      return new Promise<boolean>((r) => waiters.push(r));
    },
    /** The socket drained: writes may go on. */
    release() {
      sinceDrain = 0;
      stream.drains++;
      const w = waiters;
      waiters = [];
      for (const fn of w) fn(true);
    },
    write(event: string, data: string, id?: string) {
      if (closed) return false;
      sinceDrain++;
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
      const w = waiters;
      waiters = [];
      for (const fn of w) fn(false);
      for (const fn of cleanups) fn();
    },
    onCleanup(fn: () => void) {
      cleanups.push(fn);
    },
  };
  return stream as typeof stream & SseStream;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function hubSetup(store = new MemoryChangeLogStore<Doc>()) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const hub = createReplayHub<Doc, { user: string }>(app, {
    store,
    toFrame: (entry) => ({ event: "alert", data: { id: entry.docId, ...(entry.doc ?? {}) } }),
    pollMs: 0,
    compareCursors: cmp,
  });
  await app.ready();
  const append = (docId: string, text: string) =>
    store.append({ scope: "alerts", docId, op: "upsert", version: 1, doc: { text } });
  return { app, hub, store, append };
}

const texts = (s: { frames: Array<{ event: string; data: unknown }> }) =>
  s.frames.filter((f) => f.event === "alert").map((f) => (f.data as Doc).text);

describe("createReplayHub — paced by drain", () => {
  it("a replay waits for drain between frames; live entries meanwhile follow it, once, in order", async () => {
    const { hub, append } = await hubSetup();
    const first = await append("a0", "0");
    for (let i = 1; i <= 6; i++) await append(`a${i}`, String(i));
    const s = drainingStream(3);
    const attaching = hub.attach(s, { user: "u" }, first.cursor);
    await settle();
    // ready + 2 entries fill the buffer: the replay is parked on drain.
    expect(texts(s)).toEqual(["1", "2"]);
    await append("a7", "7");
    hub.notify();
    await settle();
    expect(texts(s)).toEqual(["1", "2"]);
    s.release();
    await settle();
    expect(texts(s)).toEqual(["1", "2", "3", "4", "5"]);
    s.release();
    await attaching;
    expect(texts(s)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(s.drains).toBe(2);
    expect(hub.stats()).toMatchObject({ subscribers: 1, replayed: 6 });
  });

  it("a live burst on a full socket is queued and written on drain, in order", async () => {
    const { hub, append } = await hubSetup();
    const s = drainingStream(2);
    await hub.attach(s, { user: "u" }, null); // ready = 1 write
    for (let i = 1; i <= 5; i++) await append(`a${i}`, String(i));
    hub.notify();
    await settle();
    expect(texts(s)).toEqual(["1"]);
    s.release();
    await settle();
    expect(texts(s)).toEqual(["1", "2", "3"]);
    s.release();
    await settle();
    s.release();
    await settle();
    expect(texts(s)).toEqual(["1", "2", "3", "4", "5"]);
    await append("a6", "6");
    hub.notify();
    await settle();
    expect(texts(s)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("a stream that closes while parked on drain detaches cleanly", async () => {
    const { hub, append } = await hubSetup();
    const first = await append("a0", "0");
    for (let i = 1; i <= 5; i++) await append(`a${i}`, String(i));
    const s = drainingStream(2);
    const attaching = hub.attach(s, { user: "u" }, first.cursor);
    await settle();
    s.close();
    const sub = await attaching;
    expect(sub.closed).toBe(true);
    expect(hub.stats()).toMatchObject({ subscribers: 0, partitions: 0 });
  });

  it("over a real socket: a 2 MB resume arrives whole after ready{resumed: true}, and the stream stays open", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const app = Fastify({ logger: false });
    const hub = createReplayHub<Doc, { user: string }>(app, {
      store,
      toFrame: (entry) => ({ event: "alert", data: { id: entry.docId, ...(entry.doc ?? {}) } }),
      pollMs: 0,
      maxReplay: 2_000,
      compareCursors: cmp,
    });
    app.get("/stream", async (request, reply) => {
      const stream = openSseStream(request, reply, { heartbeatMs: 60_000 });
      await hub.attach(stream, { user: "u" }, lastEventIdOf(request));
    });
    const base = await listen(app);
    const first = await store.append({
      scope: "alerts",
      docId: "a0",
      op: "upsert",
      version: 1,
      doc: { text: "0" },
    });
    let last: ChangeEntry<Doc> = first;
    for (let i = 1; i <= 1_200; i++) {
      last = await store.append({
        scope: "alerts",
        docId: `a${i}`,
        op: "upsert",
        version: 1,
        doc: { text: `${i}:${pad(1_800)}` },
      });
    }

    const client = sseClient(`${base}/stream`, { "last-event-id": first.cursor });
    clients.push(client);
    const ready = await client.next((f) => f.event === "ready", 15_000);
    expect(ready, "ready arrives: the socket was not cut by the replay burst").toBeDefined();
    expect(JSON.parse(ready?.data ?? "{}")).toMatchObject({ resumed: true });
    expect(await client.next((f) => f.id === last.cursor, 30_000)).toBeDefined();

    const replayed = client.frames.filter((f) => f.event === "alert");
    expect(replayed).toHaveLength(1_200);
    expect(replayed.map((f) => (JSON.parse(f.data) as Doc).text.split(":")[0])).toEqual(
      Array.from({ length: 1_200 }, (_, i) => String(i + 1)),
    );
    const bytes = replayed.reduce((sum, f) => sum + Buffer.byteLength(f.data), 0);
    expect(bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(client.ended).toBe(false);
    expect(hub.stats()).toMatchObject({ subscribers: 1, replayed: 1_200 });

    // Live still flows after the paced replay.
    const live = await store.append({
      scope: "alerts",
      docId: "live",
      op: "upsert",
      version: 1,
      doc: { text: "live" },
    });
    hub.notify();
    expect(await client.next((f) => f.id === live.cursor)).toBeDefined();
  }, 60_000);

  it("over a real socket: a replay containing one frame over maxBufferedBytes resumes", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const app = Fastify({ logger: false });
    const hub = createReplayHub<Doc, { user: string }>(app, {
      store,
      toFrame: (entry) => ({ event: "alert", data: { id: entry.docId, ...(entry.doc ?? {}) } }),
      pollMs: 0,
      compareCursors: cmp,
    });
    app.get("/stream", async (request, reply) => {
      const stream = openSseStream(request, reply, { heartbeatMs: 60_000 });
      await hub.attach(stream, { user: "u" }, lastEventIdOf(request));
    });
    const base = await listen(app);
    const first = await store.append({
      scope: "alerts",
      docId: "a0",
      op: "upsert",
      version: 1,
      doc: { text: "0" },
    });
    const big = await store.append({
      scope: "alerts",
      docId: "big",
      op: "upsert",
      version: 1,
      doc: { text: `big:${pad(1536 * 1024)}` },
    });
    const after = await store.append({
      scope: "alerts",
      docId: "a2",
      op: "upsert",
      version: 1,
      doc: { text: "2" },
    });

    const client = sseClient(`${base}/stream`, { "last-event-id": first.cursor });
    clients.push(client);
    expect(await client.next((f) => f.event === "ready")).toBeDefined();
    expect(await client.next((f) => f.id === after.cursor, 15_000)).toBeDefined();
    const bigFrame = client.frames.find((f) => f.id === big.cursor);
    expect(Buffer.byteLength(bigFrame?.data ?? "")).toBeGreaterThan(1024 * 1024);
    expect(client.ended).toBe(false);
    expect(hub.stats()).toMatchObject({ subscribers: 1, replayed: 2 });
  }, 30_000);

  it("over a real socket: a resuming client that never reads is cut by the drain timeout, not kept forever", async () => {
    const store = new MemoryChangeLogStore<Doc>();
    const app = Fastify({ logger: false });
    const hub = createReplayHub<Doc, { user: string }>(app, {
      store,
      toFrame: (entry) => ({ event: "alert", data: { id: entry.docId, ...(entry.doc ?? {}) } }),
      pollMs: 0,
      maxReplay: 5_000,
      compareCursors: cmp,
    });
    let attached: { closed: boolean } | undefined;
    app.get("/stream", async (request, reply) => {
      const stream = openSseStream(request, reply, { heartbeatMs: 60_000, drainTimeoutMs: 300 });
      attached = await hub.attach(stream, { user: "u" }, lastEventIdOf(request));
    });
    const base = await listen(app);
    const first = await store.append({
      scope: "alerts",
      docId: "a0",
      op: "upsert",
      version: 1,
      doc: { text: "0" },
    });
    for (let i = 1; i <= 3_000; i++) {
      await store.append({
        scope: "alerts",
        docId: `a${i}`,
        op: "upsert",
        version: 1,
        doc: { text: pad(8_000) },
      });
    }
    const client = sseClient(`${base}/stream`, { "last-event-id": first.cursor }, { paused: true });
    clients.push(client);
    // attach resolves (the paced replay gave up on drain), the subscription is closed.
    await vi.waitFor(() => expect(attached?.closed).toBe(true), { timeout: 30_000 });
    expect(hub.stats()).toMatchObject({ subscribers: 0, partitions: 0 });
    expect(client.frames.filter((f) => f.event === "alert").length).toBeLessThan(3_000);
  }, 60_000);
});
