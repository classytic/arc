/**
 * `RedisStreamTransport` DLQ envelope tests — verify the 2.11.3 fix that made
 * dead-lettered events replayable.
 *
 * Pre-fix: `moveToDlq` wrote only `{ originalStream, originalId, group, failedAt }`
 *          — opaque references that became unreplayable the moment the source
 *          stream's MAXLEN trim dropped the original entry.
 *
 * Post-fix: a full `DeadLetteredEvent` envelope (event payload + error reason
 *           + accurate timestamps) lands in the DLQ stream's `data` field, so
 *           operators can inspect, repair, and replay.
 *
 * Uses a fake `RedisStreamLike` — deterministic, no network, exercises the
 * transport CLASS (not a parallel mock).
 */

import { describe, expect, it } from "vitest";
import type { DeadLetteredEvent } from "../../src/events/EventTransport.js";
import { createEvent } from "../../src/events/EventTransport.js";
import {
  type RedisStreamLike,
  RedisStreamTransport,
} from "../../src/events/transports/redis-stream.js";

// ---------- Fake RedisStreamLike ----------
//
// Models XADD / XRANGE / XACK / XPENDING with enough fidelity to drive the
// DLQ replay path. The transport calls the methods we care about; everything
// else is a no-op.

interface StreamEntry {
  id: string;
  fields: string[]; // [k, v, k, v, ...]
}

function fakeStream(): RedisStreamLike & {
  store: Map<string, StreamEntry[]>;
  pending: Array<[string, string, number, number]>;
} {
  const store = new Map<string, StreamEntry[]>();
  const pending: Array<[string, string, number, number]> = [];
  let counter = 0;

  return {
    store,
    pending,
    async xadd(key, _id, ...fieldValues) {
      const arr = store.get(key) ?? [];
      counter++;
      const id = `${Date.now()}-${counter}`;
      arr.push({ id, fields: fieldValues });
      store.set(key, arr);
      return id;
    },
    async xrange(key, start, end) {
      const arr = store.get(key) ?? [];
      // Simplified: only support exact-id-to-exact-id (start === end).
      return arr.filter((e) => e.id >= start && e.id <= end).map((e) => [e.id, e.fields]);
    },
    async xreadgroup() {
      return null;
    },
    async xack(_key, _group, ..._ids) {
      return _ids.length;
    },
    async xgroup() {
      return undefined;
    },
    async xpending() {
      return pending;
    },
    async xclaim() {
      return [];
    },
    async xlen(key) {
      return store.get(key)?.length ?? 0;
    },
    async quit() {
      return "OK";
    },
  };
}

/**
 * Pull the latest DLQ entry's `data` field and parse it as a
 * `DeadLetteredEvent`. Returns `null` when nothing has been written.
 */
function readDlqEnvelope(
  redis: ReturnType<typeof fakeStream>,
  dlqStream: string,
): DeadLetteredEvent | null {
  const dlq = redis.store.get(dlqStream) ?? [];
  const last = dlq[dlq.length - 1];
  if (!last) return null;
  for (let i = 0; i < last.fields.length; i += 2) {
    if (last.fields[i] === "data") return JSON.parse(last.fields[i + 1]!) as DeadLetteredEvent;
  }
  return null;
}

// ============================================================================
// Tests
// ============================================================================

describe("RedisStreamTransport DLQ envelope — replayable contract", () => {
  it("writes a full DeadLetteredEvent envelope (payload + error + timestamps) when an in-process handler fails", async () => {
    const redis = fakeStream();

    // Seed the source stream so xrange can find the original.
    const event = createEvent("order.created", { orderId: "ord-7", total: 99 });
    const sourceId = (await redis.xadd(
      "arc:events",
      "*",
      "type",
      event.type,
      "data",
      JSON.stringify(event),
    )) as string;

    // Pre-populate the failure context the way processEntry would on a
    // handler throw — this is the canonical state when claimPending later
    // routes the message to DLQ.
    const transport = new RedisStreamTransport(redis, {
      stream: "arc:events",
      group: "test",
      consumer: "consumer-1",
      claimTimeoutMs: 10,
      maxRetries: 1,
      blockTimeMs: 50,
      closeTimeoutMs: 50,
    });

    // Reach into the private failure-context map so we can assert the DLQ
    // builder consumes it. Wraps a single failure record for the source id.
    (
      transport as unknown as {
        failureContext: Map<
          string,
          {
            error: { message: string; code?: string; stack?: string };
            firstFailedAt: Date;
            lastFailedAt: Date;
            attempts: number;
            handlerName?: string;
          }
        >;
      }
    ).failureContext.set(sourceId, {
      error: { message: "DB write timeout", code: "ETIMEDOUT" },
      firstFailedAt: new Date(Date.now() - 1000),
      lastFailedAt: new Date(),
      attempts: 2,
      handlerName: "orderProjection",
    });

    // Drive the DLQ writer directly — exercises the same path that
    // claimPending would take when a message exceeds maxRetries.
    await (transport as unknown as { moveToDlq: (ids: string[]) => Promise<void> }).moveToDlq([
      sourceId,
    ]);

    const envelope = readDlqEnvelope(redis, "arc:events:dlq");
    expect(envelope).not.toBeNull();

    // Full event survives — the whole point of this fix. Replayable.
    expect(envelope?.event.type).toBe("order.created");
    expect(envelope?.event.payload).toEqual({ orderId: "ord-7", total: 99 });

    // Error reason carried forward (was lost pre-fix).
    expect(envelope?.error.message).toBe("DB write timeout");
    expect(envelope?.error.code).toBe("ETIMEDOUT");

    // Attempt accounting + handler attribution preserved.
    expect(envelope?.attempts).toBe(2);
    expect(envelope?.handlerName).toBe("orderProjection");

    // Timestamps as ISO strings on the wire — JSON round-trip drops Date type.
    expect(typeof envelope?.firstFailedAt).toBe("string");
    expect(typeof envelope?.lastFailedAt).toBe("string");
  });

  it("falls back to a 'cross-consumer reclaim' error when no in-process failure context exists", async () => {
    // Scenario: a different consumer crashed, this consumer reclaims via
    // xpending and routes to DLQ without ever having seen the failure.
    const redis = fakeStream();

    const event = createEvent("notify.email", { to: "user@example.com" });
    const sourceId = (await redis.xadd(
      "arc:events",
      "*",
      "type",
      event.type,
      "data",
      JSON.stringify(event),
    )) as string;

    const transport = new RedisStreamTransport(redis, {
      stream: "arc:events",
      group: "test",
      consumer: "this-consumer",
      claimTimeoutMs: 10,
      blockTimeMs: 50,
      closeTimeoutMs: 50,
    });

    // No failureContext entry — this consumer never observed the failure.
    await (transport as unknown as { moveToDlq: (ids: string[]) => Promise<void> }).moveToDlq([
      sourceId,
    ]);

    const envelope = readDlqEnvelope(redis, "arc:events:dlq");
    expect(envelope?.event.type).toBe("notify.email");
    // Payload is still recovered via xrange — the replay contract holds even
    // without local error context.
    expect(envelope?.event.payload).toEqual({ to: "user@example.com" });
    // Error message documents the cross-consumer ambiguity instead of
    // pretending to know what went wrong.
    expect(envelope?.error.message).toMatch(/different consumer|context not preserved/i);
  });

  it("respects deadLetterStream:false — acks and drops without writing to DLQ", async () => {
    const redis = fakeStream();
    const transport = new RedisStreamTransport(redis, {
      stream: "arc:events",
      group: "test",
      consumer: "x",
      deadLetterStream: false,
      blockTimeMs: 50,
      closeTimeoutMs: 50,
    });

    await (transport as unknown as { moveToDlq: (ids: string[]) => Promise<void> }).moveToDlq([
      "1234-0",
    ]);

    // No DLQ stream was created.
    expect(redis.store.has("arc:events:dlq")).toBe(false);
  });

  it("close() returns within closeTimeoutMs even when poll loop has no draining iteration", async () => {
    // Verifies the bounded-shutdown contract: close() must not hang for
    // blockTimeMs. The fake never returns events from xreadgroup, so the
    // poll loop's BLOCK is the only thing keeping the close path waiting.
    const redis = fakeStream();
    const transport = new RedisStreamTransport(redis, {
      stream: "arc:events",
      group: "test",
      consumer: "x",
      blockTimeMs: 5000, // would be the worst-case wait without the fix
      closeTimeoutMs: 100,
    });

    // Subscribe to start the poll loop running.
    await transport.subscribe("anything", () => undefined);

    const start = Date.now();
    await transport.close();
    const elapsed = Date.now() - start;

    // Should drop out near closeTimeoutMs, NOT blockTimeMs.
    expect(elapsed).toBeLessThan(2000);
  });

  it("graceful fallback when the Redis client lacks xrange — envelope built from in-process failure context only", async () => {
    // Back-compat scenario: a custom Redis wrapper from before 2.11.3 that
    // implements every method EXCEPT xrange. The DLQ writer must NOT throw,
    // must NOT block the message in-stream forever; it should build the
    // best-effort envelope from `failureContext` and one-shot warn the
    // operator that payload is unavailable.
    const redis = fakeStream();
    // Strip xrange to simulate the older client shape.
    (redis as { xrange?: unknown }).xrange = undefined;

    const warnings: unknown[][] = [];
    const transport = new RedisStreamTransport(redis, {
      stream: "arc:events",
      group: "test",
      consumer: "x",
      claimTimeoutMs: 10,
      blockTimeMs: 50,
      closeTimeoutMs: 50,
      logger: {
        warn: (...args: unknown[]) => {
          warnings.push(args);
        },
        error: () => {},
      },
    });

    // Failure context exists locally — error reason should still survive.
    (
      transport as unknown as {
        failureContext: Map<
          string,
          {
            error: { message: string; code?: string; stack?: string };
            firstFailedAt: Date;
            lastFailedAt: Date;
            attempts: number;
          }
        >;
      }
    ).failureContext.set("legacy-1", {
      error: { message: "DB unreachable" },
      firstFailedAt: new Date(),
      lastFailedAt: new Date(),
      attempts: 3,
    });

    await (transport as unknown as { moveToDlq: (ids: string[]) => Promise<void> }).moveToDlq([
      "legacy-1",
    ]);

    const envelope = readDlqEnvelope(redis, "arc:events:dlq");
    expect(envelope).not.toBeNull();
    // Error envelope SURVIVES — operator triage info is intact. But replay
    // is NOT possible without xrange: payload is null and type is the
    // sentinel `<unknown>`. The contract is "error envelope survives", not
    // "replayable" — see RedisStreamLike.xrange JSDoc.
    expect(envelope?.event.type).toBe("<unknown>");
    expect(envelope?.event.payload).toBeNull();
    expect(envelope?.error.message).toBe("DB unreachable");
    expect(envelope?.attempts).toBe(3);

    // One-shot warning fired so operators know to upgrade.
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]?.[0])).toMatch(/lacks xrange/);

    // Second DLQ write does NOT re-warn (one-shot guard).
    (
      transport as unknown as {
        failureContext: Map<string, unknown>;
      }
    ).failureContext.set("legacy-2", {
      error: { message: "x" },
      firstFailedAt: new Date(),
      lastFailedAt: new Date(),
      attempts: 1,
    });
    await (transport as unknown as { moveToDlq: (ids: string[]) => Promise<void> }).moveToDlq([
      "legacy-2",
    ]);
    expect(warnings.length).toBe(1);
  });

  it("rapid subscribe → unsubscribe → subscribe does NOT spawn overlapping poll loops (generation token)", async () => {
    // Pre-fix race: subscribe() spawns pollLoop A → unsubscribe sets
    // running=false (loop A still in BLOCK) → subscribe() sees running=false
    // and spawns pollLoop B with running=true → loop A's BLOCK returns,
    // sees running===true, continues alongside loop B. Two loops on the
    // same consumer name.
    //
    // Post-fix: each poll loop captures a generation at start and exits
    // on mismatch. unsubscribe (last handler removed) and close() bump
    // the generation. The old loop reads generation !== myGen on its
    // next iteration and exits cleanly.
    const xreadgroupCalls: number[] = [];
    let xreadgroupCallNo = 0;
    const redis = fakeStream();
    // Override xreadgroup to log when each call is invoked + which "gen"
    // is active — this lets us assert the old loop stopped issuing reads.
    const origReadgroup = redis.xreadgroup;
    redis.xreadgroup = async (...args: Parameters<typeof origReadgroup>) => {
      const callNo = ++xreadgroupCallNo;
      xreadgroupCalls.push(callNo);
      // Make every read take a beat to model the BLOCK window.
      await new Promise((r) => setTimeout(r, 25));
      return origReadgroup(...args);
    };

    const transport = new RedisStreamTransport(redis, {
      stream: "arc:events",
      group: "overlap-test",
      consumer: "consumer-1",
      blockTimeMs: 25,
      closeTimeoutMs: 25,
    });

    const handler = () => undefined;
    const unsub1 = await transport.subscribe("a.*", handler);
    // Let the loop tick once.
    await new Promise((r) => setTimeout(r, 60));
    const callsAfterFirstSub = xreadgroupCalls.length;
    expect(callsAfterFirstSub).toBeGreaterThan(0);

    // Unsubscribe (last handler) — bumps generation, signals loop A to exit.
    unsub1();
    // Immediately resubscribe — spawns loop B with a NEW generation.
    await transport.subscribe("b.*", handler);

    // Give both loops one full BLOCK window to coexist if they would.
    await new Promise((r) => setTimeout(r, 100));

    // Stop everything for inspection.
    await transport.close();

    // The strong assertion: there is at most ONE active poll loop at a
    // time. We can't measure "active loops" directly, but we can measure
    // the rate of xreadgroup calls. With one loop at blockTimeMs=25ms +
    // ~25ms work, we expect ≤ ~4 calls per 100ms window. Two overlapping
    // loops would double that. We allow generous slack but not 2×.
    const totalCalls = xreadgroupCalls.length;
    // Reference: post-first-sub baseline → final count. The delta should
    // be modest, not doubled.
    const deltaAfterRace = totalCalls - callsAfterFirstSub;
    // 100ms window, ~50ms per iteration (25ms BLOCK + 25ms work) → ~2
    // calls expected from a single loop; allow up to 4 for slack. Two
    // overlapping loops would produce ~4-6+. The clean signal is "much
    // less than double a single-loop rate."
    expect(deltaAfterRace).toBeLessThan(6);
  });

  it("close() with externalLifecycle:true skips redis.quit() (host owns the connection)", async () => {
    const redis = fakeStream();
    let quitCalls = 0;
    const trackedQuit = redis.quit.bind(redis);
    redis.quit = async (...args) => {
      quitCalls++;
      return trackedQuit(...args);
    };

    const transport = new RedisStreamTransport(redis, {
      stream: "arc:events",
      group: "test",
      consumer: "x",
      externalLifecycle: true,
      blockTimeMs: 50,
      closeTimeoutMs: 50,
    });

    await transport.subscribe("anything", () => undefined);
    await transport.close();

    expect(quitCalls).toBe(0);
  });
});
