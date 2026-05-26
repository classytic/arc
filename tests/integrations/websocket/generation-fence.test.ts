/**
 * Connection lease / generation / fence — pins the 2.17.2 NEW-HIGH
 * finding: a same-principal resume against a still-active entry MUST
 * fence the prior owner before granting the new one ownership.
 *
 * Without this, two sockets in two processes could hold live
 * EnvelopeWriters for the same pushRef and race nextSeq + persist —
 * dead-queue corruption, duplicate deliveries, all the classic
 * distributed-double-writer bugs.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PushRefRegistry, websocketPlugin } from "../../../src/integrations/websocket.js";

function getPort(app: FastifyInstance): number {
  return (app.server.address() as { port: number }).port;
}

function nextMessage(ws: WebSocket, timeoutMs = 1500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    ws.once("message", (raw) => {
      clearTimeout(t);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

describe("PushRefRegistry — generation + supersededActive (claim mechanics)", () => {
  const SEQ = { envelopeMode: "seq" as const, deadQueueSize: 8 };

  it("bumps generation on every successful claim", async () => {
    const r = new PushRefRegistry();
    const a = await r.claim("tab-X", "u:alice", SEQ);
    expect(a.outcome).toBe("new");
    if (a.outcome !== "new") throw new Error("expected new");
    expect(a.generation).toBe(1);

    await r.release("tab-X", a.generation);
    const b = await r.claim("tab-X", "u:alice", SEQ);
    if (b.outcome !== "resumed") throw new Error("expected resumed");
    expect(b.generation).toBe(2);
  });

  it("reports supersededActive=true when claiming over a still-active entry", async () => {
    const r = new PushRefRegistry();
    await r.claim("tab-X", "u:alice", SEQ);
    // DO NOT release — simulate a faster reconnect arriving while the
    // original socket is still live.
    const racy = await r.claim("tab-X", "u:alice", SEQ);
    if (racy.outcome !== "resumed") throw new Error("expected resumed");
    expect(racy.supersededActive).toBe(true);
    expect(racy.generation).toBe(2);
  });

  it("reports supersededActive=false when prior entry was already released", async () => {
    const r = new PushRefRegistry();
    const a = await r.claim("tab-X", "u:alice", SEQ);
    if (a.outcome === "rejected") throw new Error("unexpected reject");
    await r.release("tab-X", a.generation);
    const clean = await r.claim("tab-X", "u:alice", SEQ);
    if (clean.outcome !== "resumed") throw new Error("expected resumed");
    expect(clean.supersededActive).toBe(false);
  });
});

// ============================================================================
// Distributed stale-write fence (the 2.17.2 review NEW-HIGH requirement)
// ============================================================================

describe("PushRefRegistry — generation-fenced writes refuse stale mutations", () => {
  const SEQ = { envelopeMode: "seq" as const, deadQueueSize: 8 };

  it("stale release from a fenced node leaves the new owner's entry intact", async () => {
    // Simulates the 2.17.2 review scenario:
    //   1. Node A claims pushRef at generation 1 (active).
    //   2. Node B reclaims same pushRef — registry bumps to generation 2.
    //   3. Node A's old socket then fires its close handler and calls
    //      release(pushRef, generation: 1).
    //   4. Without the CAS fix this could mark Node B's entry inactive
    //      OR clobber Node B's snapshot with Node A's stale state.
    //   5. With the fix: release returns `stale`, Node B's entry is
    //      untouched (still active, generation 2, no envelope state lost).
    const r = new PushRefRegistry();
    const a = await r.claim("tab-X", "u:alice", SEQ);
    if (a.outcome !== "new" || !a.envelope) throw new Error("expected new");
    a.envelope.wrap({ from: "node-A" });
    await r.persist("tab-X", a.generation);

    // Node B's claim happens BEFORE Node A's release — supersedes.
    const b = await r.claim("tab-X", "u:alice", SEQ);
    if (b.outcome !== "resumed" || !b.envelope) throw new Error("expected resumed");
    expect(b.supersededActive).toBe(true);
    expect(b.generation).toBe(2);

    // Node B writes its own envelope frame.
    b.envelope.wrap({ from: "node-B" });
    await r.persist("tab-X", b.generation);

    // Node A's late release fires — must be refused by the CAS.
    const releaseOutcome = await r.release("tab-X", a.generation);
    expect(releaseOutcome).toBe("stale");

    // Node B's entry must still be active, still generation 2, with
    // both envelope frames (Node A's pre-fence + Node B's post-claim).
    const snapshot = await r.inspect("tab-X");
    expect(snapshot?.active).toBe(true);
    expect(snapshot?.generation).toBe(2);
    expect(snapshot?.deadQueue.length).toBe(2);
  });

  it("stale persist from a fenced node leaves the new owner's dead queue intact", async () => {
    const r = new PushRefRegistry();
    const a = await r.claim("tab-X", "u:alice", SEQ);
    if (a.outcome !== "new" || !a.envelope) throw new Error("expected new");
    a.envelope.wrap({ frame: "a-1" });
    a.envelope.wrap({ frame: "a-2" });

    // Node B supersedes.
    const b = await r.claim("tab-X", "u:alice", SEQ);
    if (b.outcome !== "resumed" || !b.envelope) throw new Error("expected resumed");
    b.envelope.wrap({ frame: "b-1" });
    await r.persist("tab-X", b.generation);

    // Node A's in-flight persist arrives late — CAS must refuse.
    const persistOutcome = await r.persist("tab-X", a.generation);
    expect(persistOutcome).toBe("stale");

    // Node B's snapshot still has its own deadQueue, not Node A's.
    const snapshot = await r.inspect("tab-X");
    expect(snapshot?.deadQueue.map((e) => e.seq).sort()).toEqual([1, 2, 3]);
    expect(snapshot?.generation).toBe(2);
  });

  it("stageForResume refuses to clobber a freshly-claimed active entry (stage-vs-claim race)", async () => {
    // The 2.17.2 HIGH on stageForResume: between the original
    // implementation's get() and set(), another node could claim the
    // pushRef and become the new active owner. A non-atomic stage
    // would then overwrite the freshly-claimed active entry with the
    // stale "inactive + old snapshot" view — losing the new owner's
    // generation bump and any frames it had already written.
    //
    // With the atomic store primitive, stageForResume never sees the
    // intermediate state — `stageIfInactive` reads + writes under one
    // turn, and a stage that arrives AFTER a claim sees active=true
    // and is dropped.
    const r = new PushRefRegistry();
    const a = await r.claim("tab-X", "u:alice", SEQ);
    if (a.outcome !== "new" || !a.envelope) throw new Error("expected new");
    a.envelope.wrap({ frame: "a-1" });
    await r.persist("tab-X", a.generation);
    await r.release("tab-X", a.generation);

    // Re-claim (Node B). Entry is now active again, generation = 2,
    // dead queue carries the prior frame.
    const b = await r.claim("tab-X", "u:alice", SEQ);
    if (b.outcome !== "resumed" || !b.envelope) throw new Error("expected resumed");
    b.envelope.wrap({ frame: "b-1" });
    await r.persist("tab-X", b.generation);

    // A late stageForResume call lands AFTER the reclaim. Without the
    // atomic primitive this would mutate the now-active entry's dead
    // queue. With the primitive it sees active=true and returns false.
    const staged = await r.stageForResume("tab-X", { frame: "late-stage" });
    expect(staged).toBe(false);

    // Node B's entry untouched — still active, gen 2, original two frames.
    const snapshot = await r.inspect("tab-X");
    expect(snapshot?.active).toBe(true);
    expect(snapshot?.generation).toBe(2);
    expect(snapshot?.deadQueue.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("Redis store enforces the same CAS contract via Lua", async () => {
    const { RedisPushRefStore } = await import(
      "../../../src/integrations/websocket-pushref-redis.js"
    );
    // Reuse the FakeRedis harness from the redis test file via dynamic import.
    const { FakeRedis } = (await import("./_fake-redis.js")) as {
      FakeRedis: new () => import("../../../src/integrations/websocket-pushref-redis.js").RedisLike;
    };
    const fake = new FakeRedis();
    const nodeA = new PushRefRegistry({ store: new RedisPushRefStore(fake) });
    const nodeB = new PushRefRegistry({ store: new RedisPushRefStore(fake) });

    const a = await nodeA.claim("tab-X", "u:alice", SEQ);
    if (a.outcome !== "new" || !a.envelope) throw new Error("expected new");
    a.envelope.wrap({ frame: "a-1" });
    await nodeA.persist("tab-X", a.generation);

    const b = await nodeB.claim("tab-X", "u:alice", SEQ);
    if (b.outcome !== "resumed" || !b.envelope) throw new Error("expected resumed");
    expect(b.supersededActive).toBe(true);
    b.envelope.wrap({ frame: "b-1" });
    await nodeB.persist("tab-X", b.generation);

    // Node A's stale release races in via the SHARED store.
    const releaseOutcome = await nodeA.release("tab-X", a.generation);
    expect(releaseOutcome).toBe("stale");

    // Node B is unaffected.
    const snapshot = await nodeB.inspect("tab-X");
    expect(snapshot?.active).toBe(true);
    expect(snapshot?.generation).toBe(2);
    // Both frames in order (a-1 was persisted with seq 1; b-1 with seq 2).
    expect(snapshot?.deadQueue.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("Redis store: stage races a claim and loses (atomic Lua refuses)", async () => {
    const { RedisPushRefStore } = await import(
      "../../../src/integrations/websocket-pushref-redis.js"
    );
    const { FakeRedis } = await import("./_fake-redis.js");
    const fake = new FakeRedis();
    const nodeA = new PushRefRegistry({ store: new RedisPushRefStore(fake) });
    const nodeB = new PushRefRegistry({ store: new RedisPushRefStore(fake) });

    const a = await nodeA.claim("tab-X", "u:alice", SEQ);
    if (a.outcome !== "new" || !a.envelope) throw new Error("expected new");
    await nodeA.release("tab-X", a.generation);

    // Node B claims (entry now active again, generation 2).
    const b = await nodeB.claim("tab-X", "u:alice", SEQ);
    if (b.outcome !== "resumed" || !b.envelope) throw new Error("expected resumed");
    b.envelope.wrap({ frame: "b-1" });
    await nodeB.persist("tab-X", b.generation);

    // Late stage on Node A's view — under non-atomic semantics this
    // would have clobbered the entry. With the Lua primitive, it
    // sees active=true and returns false.
    const staged = await nodeA.stageForResume("tab-X", { frame: "late" });
    expect(staged).toBe(false);

    const snapshot = await nodeB.inspect("tab-X");
    expect(snapshot?.active).toBe(true);
    expect(snapshot?.generation).toBe(2);
    expect(snapshot?.deadQueue.length).toBe(1);
  });
});

describe("WebSocket — superseded local socket is closed at 4011", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
  });

  it("closes the previous live socket when a new claim arrives with the same pushRef", async () => {
    // Auth-on with userId echoing so both sockets share principal.
    app = Fastify({ logger: false });
    await app.register(websocketPlugin, {
      auth: true,
      heartbeatInterval: 0,
      messageEnvelope: "seq",
      authenticate: async (req) => {
        const url = (req as { url?: string }).url ?? "";
        const u = new URL(url, "http://x");
        return { userId: u.searchParams.get("u") ?? undefined };
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(app);

    // First socket — claims pushRef X for u:alice
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?u=alice`);
    const conn1 = (await nextMessage(ws1)) as { pushRef: string };
    const pushRef = conn1.pushRef;

    // Capture ws1 close before opening ws2 — a fence on the registry
    // claim path closes ws1 with 4011.
    const ws1Close = new Promise<{ code: number; reason: string }>((resolve) => {
      ws1.on("close", (c, r) => resolve({ code: c, reason: r.toString() }));
    });

    // Second socket — same principal, same pushRef. Must supersede.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?u=alice&pushRef=${pushRef}`);
    const conn2 = (await nextMessage(ws2)) as { pushRef: string; resumed?: boolean };
    expect(conn2.pushRef).toBe(pushRef);
    expect(conn2.resumed).toBe(true);

    const { code, reason } = await ws1Close;
    expect(code).toBe(4011);
    expect(reason).toBe("Superseded by newer connection");

    ws2.close();
  });
});
