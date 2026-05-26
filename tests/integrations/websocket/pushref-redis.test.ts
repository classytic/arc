/**
 * Redis-backed PushRefStore — verified against a Map-backed ioredis
 * mock that implements the EVAL semantics in JavaScript so we can pin
 * the wire-level behavior without a real Redis dependency in CI.
 *
 * Real-Redis smoke is covered by `tests/e2e/upstash-redis-e2e.test.ts`
 * (same pattern as the other Redis-backed integrations).
 */

import { describe, expect, it } from "vitest";
import { PushRefRegistry } from "../../../src/integrations/websocket.js";
import { RedisPushRefStore } from "../../../src/integrations/websocket-pushref-redis.js";
import { FakeRedis } from "./_fake-redis.js";

describe("RedisPushRefStore — end-to-end behind PushRefRegistry", () => {
  const RAW = { envelopeMode: "raw" as const, deadQueueSize: 8 };
  const SEQ = { envelopeMode: "seq" as const, deadQueueSize: 8 };

  it("returns 'new' then 'resumed' for same principal", async () => {
    const r = new PushRefRegistry({ store: new RedisPushRefStore(new FakeRedis()) });
    const a = await r.claim("tab-X", "u:alice", RAW);
    expect(a.outcome).toBe("new");
    if (a.outcome === "rejected") throw new Error("unexpected reject");
    await r.release("tab-X", a.generation);
    const b = await r.claim("tab-X", "u:alice", RAW);
    expect(b.outcome).toBe("resumed");
  });

  it("rejects principal mismatch (hijack defense across nodes)", async () => {
    const fake = new FakeRedis();
    const nodeA = new PushRefRegistry({ store: new RedisPushRefStore(fake) });
    const nodeB = new PushRefRegistry({ store: new RedisPushRefStore(fake) });
    await nodeA.claim("tab-X", "u:alice", RAW);
    const hijack = await nodeB.claim("tab-X", "u:bob", RAW);
    expect(hijack.outcome).toBe("rejected");
  });

  it("envelope + dead queue survive a node-to-node reconnect (the High-1 fix)", async () => {
    const fake = new FakeRedis();
    const nodeA = new PushRefRegistry({ store: new RedisPushRefStore(fake) });
    const nodeB = new PushRefRegistry({ store: new RedisPushRefStore(fake) });

    // Node A: claim, write a few envelopes, release.
    const a = await nodeA.claim("tab-X", "u:alice", SEQ);
    expect(a.outcome).toBe("new");
    if (a.outcome !== "new" || !a.envelope) throw new Error("expected envelope");
    a.envelope.wrap({ n: 1 });
    a.envelope.wrap({ n: 2 });
    a.envelope.wrap({ n: 3 });
    await nodeA.persist("tab-X", a.generation);
    await nodeA.release("tab-X", a.generation);

    // Node B: re-claim with same principal. Dead queue MUST carry over.
    const b = await nodeB.claim("tab-X", "u:alice", SEQ);
    expect(b.outcome).toBe("resumed");
    if (b.outcome !== "resumed" || !b.envelope) throw new Error("expected resume envelope");
    expect(b.envelope.peekNextSeq()).toBe(4);
    const drained = b.envelope.drainAfter(1);
    expect(drained).not.toBeNull();
    expect(drained?.length).toBe(2);
  });

  it("stageForResume writes through the store (offline send during disconnect)", async () => {
    const fake = new FakeRedis();
    const r = new PushRefRegistry({ store: new RedisPushRefStore(fake) });
    const a = await r.claim("tab-X", "u:alice", SEQ);
    if (a.outcome !== "new" || !a.envelope) throw new Error("expected envelope");
    await r.persist("tab-X", a.generation);
    await r.release("tab-X", a.generation);

    // While the client is offline, stage a critical message.
    const staged = await r.stageForResume("tab-X", { msg: "while-disconnected" });
    expect(staged).toBe(true);

    // Reconnect — replay surfaces the staged frame.
    const b = await r.claim("tab-X", "u:alice", SEQ);
    if (b.outcome !== "resumed" || !b.envelope) throw new Error("expected resume envelope");
    expect(b.envelope.snapshotDeadQueue().length).toBe(1);
  });
});
