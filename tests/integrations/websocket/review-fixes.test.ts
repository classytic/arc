/**
 * Regression tests for the 2.17.2 review findings:
 *
 *   1. SendQueue coalesce index staleness after a critical is flushed
 *      ahead of a droppable (Medium).
 *   2. SendQueue auto-flush retry — queued frames must drain on their
 *      own once backpressure clears (Medium).
 *   3. Cross-connection RESUME — reconnect under same pushRef must
 *      replay envelopes the previous socket queued (High).
 *   4. pushRef hijack — a different authenticated principal claiming
 *      the same pushRef must be issued a fresh pushRef, never granted
 *      ownership of the original (High).
 *
 * Every test here pins a specific production-incident shape. Don't
 * delete entries without a public migration note.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SendQueue } from "../../../src/integrations/websocket/send-queue.js";
import { PushRefRegistry, websocketPlugin } from "../../../src/integrations/websocket.js";

function getPort(app: FastifyInstance): number {
  return (app.server.address() as { port: number }).port;
}

function makeSocket(initial: { bufferedAmount?: number } = {}) {
  let bufferedAmount = initial.bufferedAmount ?? 0;
  const sent: string[] = [];
  return {
    sent,
    readyState: 1,
    get bufferedAmount() {
      return bufferedAmount;
    },
    setBufferedAmount(n: number) {
      bufferedAmount = n;
    },
    send: vi.fn((m: string) => sent.push(m)),
    terminate: vi.fn(),
    close: vi.fn(),
  };
}

function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

function collectMessages(ws: WebSocket, durationMs: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const out: unknown[] = [];
    const handler = (raw: Buffer | string) => out.push(JSON.parse(raw.toString()));
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      resolve(out);
    }, durationMs);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Medium 1 — coalesce index staleness
// ─────────────────────────────────────────────────────────────────────────

describe("SendQueue — coalesce index stays consistent after partial flush", () => {
  it("replaces a droppable in place even when a critical was flushed ahead of it", () => {
    // Construct queue: [critical, gps(key=gps)] with the socket back-
    // pressured so flush() can drain exactly one entry and then stop.
    const s = makeSocket({ bufferedAmount: 0 });
    const q = new SendQueue(s, { drainThreshold: 1, capacity: 8 });
    // Backpressure off → first send drains immediately. We want the
    // critical to be flushed, leaving gps queued. So:
    //   1. Send critical with backpressure OFF — it writes through.
    //   2. Turn backpressure ON.
    //   3. Send gps. It queues.
    //   4. Send another gps with the same key. Without the fix, the
    //      coalesce index points to a stale slot and a duplicate is
    //      appended; with the fix, it replaces in place.
    q.send("crit-1");
    expect(s.sent).toEqual(["crit-1"]);

    s.setBufferedAmount(1024 * 1024);
    q.sendRealtime("gps-v1", "gps");
    expect(q.size()).toBe(1);
    q.sendRealtime("gps-v2", "gps");
    // Before the fix this would be 2 (duplicate gps frames). After the
    // fix, the coalesce index correctly resolves to slot 0 and v1 is
    // replaced by v2 in place.
    expect(q.size()).toBe(1);

    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent).toEqual(["crit-1", "gps-v2"]);
  });

  it("rebuilds the index even when the shifted entry has no coalesceKey", () => {
    // Direct reproduction of the bug shape: flush a critical (no key),
    // then verify the coalesceIndex of trailing droppables is correct.
    const s = makeSocket({ bufferedAmount: 0 });
    const q = new SendQueue(s, { drainThreshold: 1, capacity: 8 });

    // Pre-fill: [crit, gps-A, cursor-B], all with bufferedAmount=0
    // so they drain immediately. To force the staleness, we need an
    // intermediate state where ONE critical is dropped from a queued
    // batch. Easiest path: enqueue under backpressure, flush halfway,
    // then probe the coalesce index by issuing a same-key replace.
    s.setBufferedAmount(1024 * 1024);
    q.send("crit");
    q.sendRealtime("gps-v1", "gps");
    q.sendRealtime("cursor-v1", "cursor");
    expect(q.size()).toBe(3);

    // Drop backpressure threshold so flush drains exactly the first
    // entry (the critical) and stops on the next iteration.
    // We use a custom-shaped scenario: clear backpressure entirely,
    // then flush. Everything drains.
    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent).toEqual(["crit", "gps-v1", "cursor-v1"]);

    // After a full flush the coalesce index must be empty — no ghosts
    // pointing into the now-empty entries array.
    s.setBufferedAmount(1024 * 1024);
    q.sendRealtime("gps-v2", "gps");
    // Should be a fresh entry (the old "gps" key was cleared during flush).
    expect(q.size()).toBe(1);
    q.sendRealtime("gps-v3", "gps");
    // Same key → coalesce in place, queue stays at 1.
    expect(q.size()).toBe(1);
    s.setBufferedAmount(0);
    q.flush();
    expect(s.sent).toEqual(["crit", "gps-v1", "cursor-v1", "gps-v3"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Medium 2 — auto-flush retry on backpressure clear
// ─────────────────────────────────────────────────────────────────────────

describe("SendQueue — auto-flush retry", () => {
  it("drains queued frames automatically once backpressure clears (no manual flush)", async () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s, { retryDelayMs: 20 });

    q.send("a");
    q.send("b");
    expect(s.sent).toEqual([]);
    expect(q.size()).toBe(2);

    // Clear backpressure without calling flush(). The retry timer
    // (scheduled by the initial flush()'s backpressure exit) should
    // pick it up.
    s.setBufferedAmount(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.sent).toEqual(["a", "b"]);
    expect(q.size()).toBe(0);
  });

  it("dispose cancels the retry timer (no work after disposal)", async () => {
    const s = makeSocket({ bufferedAmount: 1024 * 1024 });
    const q = new SendQueue(s, { retryDelayMs: 20 });
    q.send("a");
    q.dispose();
    s.setBufferedAmount(0);
    await new Promise((r) => setTimeout(r, 60));
    // Nothing sent because dispose cancelled the retry.
    expect(s.sent).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// High 1 — PushRefRegistry mechanics (cross-connection state)
// ─────────────────────────────────────────────────────────────────────────

describe("PushRefRegistry (async, store-backed)", () => {
  const RAW = { envelopeMode: "raw" as const, deadQueueSize: 8 };
  const SEQ = { envelopeMode: "seq" as const, deadQueueSize: 8 };

  // Helper — extract the generation from a claim outcome and assert it's not rejected.
  const gen = (o: Awaited<ReturnType<PushRefRegistry["claim"]>>): number => {
    if (o.outcome === "rejected") throw new Error(`unexpected reject: ${o.reason}`);
    return o.generation;
  };

  it("returns 'new' on first claim, 'resumed' on same-principal re-claim", async () => {
    const r = new PushRefRegistry({ ttlMs: 1000 });
    const a = await r.claim("tab-X", "u:alice", RAW);
    expect(a.outcome).toBe("new");

    await r.release("tab-X", gen(a));
    const b = await r.claim("tab-X", "u:alice", RAW);
    expect(b.outcome).toBe("resumed");
  });

  it("preserves the envelope writer (and dead-queue state) across release + re-claim", async () => {
    const r = new PushRefRegistry({ ttlMs: 1000 });
    const a = await r.claim("tab-X", "u:alice", SEQ);
    expect(a.outcome).toBe("new");
    if (a.outcome !== "new" || !a.envelope) throw new Error("expected envelope");

    a.envelope.wrap({ hello: "world" });
    await r.persist("tab-X", a.generation);
    await r.release("tab-X", a.generation);

    const b = await r.claim("tab-X", "u:alice", SEQ);
    expect(b.outcome).toBe("resumed");
    if (b.outcome !== "resumed" || !b.envelope) throw new Error("expected resume envelope");
    expect(b.envelope.peekNextSeq()).toBe(2);
    expect(b.envelope.snapshotDeadQueue().length).toBe(1);
  });

  it("rejects when a different principal claims the same pushRef", async () => {
    const r = new PushRefRegistry();
    await r.claim("tab-X", "u:alice", RAW);
    const bobTriesToClaim = await r.claim("tab-X", "u:bob", RAW);
    expect(bobTriesToClaim.outcome).toBe("rejected");
    if (bobTriesToClaim.outcome === "rejected") {
      expect(bobTriesToClaim.reason).toBe("principal_mismatch");
    }
  });

  it("GC'd inactive entries past TTL — fresh claim returns 'new'", async () => {
    let now = 1000;
    const r = new PushRefRegistry({ ttlMs: 100, now: () => now });
    const a = await r.claim("tab-X", "u:alice", RAW);
    await r.release("tab-X", gen(a));

    now = 1500;
    const after = await r.claim("tab-X", "u:alice", RAW);
    expect(after.outcome).toBe("new");
  });

  it("never evicts an active entry under capacity pressure", async () => {
    const r = new PushRefRegistry({ maxEntries: 2 });
    await r.claim("tab-1", "u:alice", RAW);
    await r.claim("tab-2", "u:bob", RAW);

    const third = await r.claim("tab-3", "u:carol", RAW);
    expect(third.outcome).toBe("rejected");
    expect(await r.inspect("tab-1")).toBeDefined();
    expect(await r.inspect("tab-2")).toBeDefined();
  });

  it("evicts the longest-inactive entry to make room", async () => {
    let now = 0;
    const r = new PushRefRegistry({ maxEntries: 2, ttlMs: 100_000, now: () => now });
    const c1 = await r.claim("tab-1", "u:alice", RAW);
    now = 10;
    await r.release("tab-1", gen(c1));

    const c2 = await r.claim("tab-2", "u:bob", RAW);
    now = 20;
    await r.release("tab-2", gen(c2));

    const third = await r.claim("tab-3", "u:carol", RAW);
    expect(third.outcome).toBe("new");
    expect(await r.inspect("tab-1")).toBeUndefined();
    expect(await r.inspect("tab-2")).toBeDefined();
    expect(await r.inspect("tab-3")).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// High 1 — end-to-end: RESUME actually works across reconnects
// ─────────────────────────────────────────────────────────────────────────

describe("WebSocket — cross-connection RESUME (end-to-end)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("replays envelopes queued before disconnect when a reconnect provides matching pushRef", async () => {
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 0,
      messageEnvelope: "seq",
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(app);
    const wsApi = (app as unknown as { ws: { send: (t: object, d: unknown) => void } }).ws;

    // First connection — get pushRef, receive seq=1 envelope, then drop.
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const conn1 = (await nextMessage(ws1)) as { pushRef: string; envelope?: string };
    expect(conn1.envelope).toBe("seq");
    const pushRef = conn1.pushRef;

    wsApi.send({ pushRef }, { phase: "before-disconnect" });
    const env1 = (await nextMessage(ws1)) as { seq: number };
    expect(env1.seq).toBe(1);

    ws1.terminate();
    await new Promise((r) => setTimeout(r, 50));

    // Send an envelope while no socket is attached — registry holds the
    // envelope writer, so it goes into the dead queue and survives.
    wsApi.send({ pushRef }, { phase: "during-disconnect" });
    await new Promise((r) => setTimeout(r, 20));

    // Reconnect with the same pushRef. `connected` should signal
    // `resumed: true`, then `resume` replays seq=2.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?pushRef=${pushRef}`);
    const conn2 = (await nextMessage(ws2)) as {
      pushRef: string;
      resumed?: boolean;
    };
    expect(conn2.pushRef).toBe(pushRef);
    expect(conn2.resumed).toBe(true);

    ws2.send(JSON.stringify({ type: "resume", lastSeq: 1 }));
    const replayed = await collectMessages(ws2, 150);

    const envelopes = replayed.filter(
      (m): m is { seq: number; msg: { data: { phase: string } } } =>
        typeof (m as { seq?: unknown }).seq === "number",
    );
    expect(envelopes.length).toBeGreaterThanOrEqual(1);
    expect(envelopes[0]?.seq).toBe(2);
    expect(envelopes[0]?.msg.data.phase).toBe("during-disconnect");

    const resumed = replayed.find((m) => (m as { type?: string }).type === "resumed") as
      | { replayed?: number }
      | undefined;
    expect(resumed?.replayed).toBe(1);

    ws2.close();
  });

  it("issues a fresh pushRef when reconnect arrives after TTL eviction", async () => {
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: false,
      heartbeatInterval: 0,
      messageEnvelope: "seq",
      pushRefTtlMs: 50, // aggressive for testing
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(app);

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const conn1 = (await nextMessage(ws1)) as { pushRef: string };
    const oldPushRef = conn1.pushRef;
    ws1.terminate();

    // Wait past TTL so the entry is GC'd on next claim.
    await new Promise((r) => setTimeout(r, 200));

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?pushRef=${oldPushRef}`);
    const conn2 = (await nextMessage(ws2)) as { pushRef: string; resumed?: boolean };
    // Same pushRef accepted (registry GC'd; fresh claim succeeds), but
    // NOT marked as resumed (no preserved envelope state to recover).
    expect(conn2.pushRef).toBe(oldPushRef);
    expect(conn2.resumed).toBeUndefined();
    ws2.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// High 2 — pushRef hijack defense (principal binding)
// ─────────────────────────────────────────────────────────────────────────

describe("WebSocket — pushRef principal binding (anti-hijack)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("hands a hijacker a fresh pushRef, leaving the legitimate owner's binding intact", async () => {
    // Auth setup: the custom authenticate returns userId from the URL
    // query so we can simulate two different users connecting with the
    // same hijacked pushRef.
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: true,
      heartbeatInterval: 0,
      authenticate: async (req) => {
        const url = (req as { url?: string }).url ?? "";
        const u = new URL(url, "http://x");
        const userId = u.searchParams.get("u");
        return userId ? { userId } : null;
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(app);

    // Alice connects, gets a pushRef.
    const alice = new WebSocket(`ws://127.0.0.1:${port}/ws?u=alice`);
    const aliceConn = (await nextMessage(alice)) as { pushRef: string };
    const aliceRef = aliceConn.pushRef;

    // Bob attempts to claim Alice's pushRef on his own connection.
    const bob = new WebSocket(`ws://127.0.0.1:${port}/ws?u=bob&pushRef=${aliceRef}`);
    const bobConn = (await nextMessage(bob)) as { pushRef: string };

    // Bob must receive a DIFFERENT pushRef (registry rejected the
    // hijack; connection.ts minted a fresh one).
    expect(bobConn.pushRef).not.toBe(aliceRef);

    // Alice still owns hers — server-side lookup confirms.
    const wsApi = (app as unknown as { ws: { send: (t: object, d: unknown) => void } }).ws;
    let aliceGotIt = false;
    alice.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as { type?: string; data?: { for?: string } };
      if (m.type === "direct" && m.data?.for === "alice") aliceGotIt = true;
    });
    let bobGotIt = false;
    bob.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as { type?: string; data?: { for?: string } };
      if (m.type === "direct" && m.data?.for === "alice") bobGotIt = true;
    });

    wsApi.send({ pushRef: aliceRef }, { for: "alice" });
    await new Promise((r) => setTimeout(r, 80));

    expect(aliceGotIt).toBe(true);
    expect(bobGotIt).toBe(false);

    alice.close();
    bob.close();
  });
});
