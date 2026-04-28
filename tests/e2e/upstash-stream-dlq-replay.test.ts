/**
 * Real-Upstash integration test for the 2.11.3 Redis Streams DLQ replay
 * envelope and bounded-shutdown contract.
 *
 * Pre-fix DLQ entries carried only `{ originalStream, originalId, group,
 * failedAt }` — opaque references that became unreplayable the moment the
 * source stream's MAXLEN trim dropped the original entry.
 *
 * This test forces a real handler failure, drives the DLQ writer end-to-end
 * against a live Upstash Redis instance, and inspects the DLQ stream
 * contents. The assertion catches regressions where the envelope shape
 * silently slips back to references-only.
 *
 * Skipped when `UPSTASH_REDIS_URL` is unset — never fails CI without creds.
 *
 * Run:
 *   npm run test:e2e -- tests/e2e/upstash-stream-dlq-replay.test.ts
 */

import "dotenv/config";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeadLetteredEvent, DomainEvent } from "../../src/events/EventTransport.js";
import { createEvent } from "../../src/events/EventTransport.js";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";

const redisUrl = process.env.UPSTASH_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

/** ioredis tuned for Upstash. */
function makeRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

/** Unique suffix per run so reruns / parallel envs don't collide. */
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const stream = `arc:test:dlq-replay:${runId}`;
const dlqStream = `${stream}:dlq`;

describeRedis("Upstash Redis Streams — DLQ replay envelope (2.11.3)", () => {
  let redis: Redis;
  let transport: RedisStreamTransport | undefined;

  beforeAll(async () => {
    redis = makeRedis(redisUrl as string);
    // Ensure clean slate. `del` is no-op on missing keys; safe to run unconditionally.
    await redis.del(stream, dlqStream);
  });

  afterAll(async () => {
    await transport?.close().catch(() => undefined);
    await redis.del(stream, dlqStream).catch(() => undefined);
    await redis.quit().catch(() => undefined);
  });

  it("dead-letters a failing handler with a full DeadLetteredEvent envelope (replayable)", async () => {
    // Tight retry budget so the test resolves quickly. claimTimeoutMs is the
    // floor on how long we wait before pending claim → DLQ.
    transport = new RedisStreamTransport(redis, {
      stream,
      deadLetterStream: dlqStream,
      group: "replay-group",
      consumer: `consumer-${runId}`,
      maxRetries: 1,
      claimTimeoutMs: 200,
      blockTimeMs: 200,
      closeTimeoutMs: 500,
    });

    let attempts = 0;
    await transport.subscribe("billing.charge", async () => {
      attempts++;
      // Every delivery fails — drives the message through retry → DLQ.
      const err = new Error("Stripe API timeout") as Error & { code?: string };
      err.code = "ETIMEDOUT";
      throw err;
    });

    // Publish an event with a recognisable payload + correlationId so we
    // can verify the envelope round-tripped both.
    const correlationId = `corr-${runId}`;
    const wireEvent = createEvent(
      "billing.charge",
      { customerId: "cus-replay", amountCents: 4999, currency: "USD" },
      { correlationId },
    );
    await transport.publish(wireEvent);

    // Wait for: at least one failed delivery + claim window + DLQ write.
    // We poll xlen on the DLQ stream to avoid relying on fixed sleeps.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const len = await redis.xlen(dlqStream).catch(() => 0);
      if (len > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(attempts).toBeGreaterThanOrEqual(1);

    // Read the DLQ entry and decode the envelope.
    const entries = await redis.xrange(dlqStream, "-", "+");
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const fields = entries[0]?.[1] ?? [];
    const fieldMap = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      fieldMap.set(fields[i]!, fields[i + 1]!);
    }

    // Backwards-compat metadata still written for grep-ability.
    expect(fieldMap.get("type")).toBe("billing.charge");
    expect(fieldMap.get("originalStream")).toBe(stream);
    expect(fieldMap.get("group")).toBe("replay-group");

    // The actual replay payload — `data` is the full DeadLetteredEvent JSON.
    const data = fieldMap.get("data");
    expect(data).toBeDefined();
    const envelope = JSON.parse(data as string) as DeadLetteredEvent;

    // Original event preserved → replay is a single re-publish away.
    expect(envelope.event.type).toBe("billing.charge");
    expect((envelope.event as DomainEvent<{ customerId: string; amountCents: number }>).payload).toEqual({
      customerId: "cus-replay",
      amountCents: 4999,
      currency: "USD",
    });
    expect(envelope.event.meta.correlationId).toBe(correlationId);

    // Error context survives — was lost pre-fix.
    expect(envelope.error.message).toMatch(/Stripe API timeout/);
    // The `code` field flows through when the host's error carries one.
    expect(envelope.error.code).toBe("ETIMEDOUT");

    expect(envelope.attempts).toBeGreaterThanOrEqual(1);
  }, 45_000);

  it("close() returns within closeTimeoutMs even when blockTimeMs is much larger", async () => {
    // Bounded-shutdown contract — pre-fix `close()` could wait up to
    // blockTimeMs (default 5s) for the in-flight XREADGROUP BLOCK.
    const t = new RedisStreamTransport(redis, {
      stream: `${stream}:close-bound`,
      deadLetterStream: false,
      group: "close-test",
      consumer: `consumer-close-${runId}`,
      blockTimeMs: 10_000, // would be the worst-case wait without the fix
      closeTimeoutMs: 500,
    });
    await t.subscribe("anything", () => undefined);
    // Give the poll loop a moment to enter XREADGROUP BLOCK.
    await new Promise((r) => setTimeout(r, 100));

    const start = Date.now();
    await t.close();
    const elapsed = Date.now() - start;

    // Allow generous slack for Upstash round-trip but still well under blockTimeMs.
    expect(elapsed).toBeLessThan(3000);
  }, 15_000);
});
