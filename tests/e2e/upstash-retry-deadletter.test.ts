/**
 * Integration test: `withRetry({ transport })` against real Upstash Redis.
 *
 * Covers the end-to-end story the feature exists for:
 *
 *   1. Publish an event with `meta.idempotencyKey` through `RedisEventTransport`
 *      (pub/sub). Confirm the key survives the wire — any consumer can dedupe
 *      with `if (processed.has(meta.idempotencyKey)) return`.
 *   2. Subscribe with `withRetry({ transport: customDlqTransport })`. Force
 *      the handler to throw every time. Confirm the wrapped handler routes
 *      to `transport.deadLetter()` with a proper `DeadLetteredEvent` envelope
 *      after retries exhaust — no custom `$deadLetter` plumbing.
 *
 * Skipped when `UPSTASH_REDIS_URL` is not set.
 */

import "dotenv/config";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEvent,
  type DeadLetteredEvent,
  type DomainEvent,
  type EventTransport,
} from "../../src/events/EventTransport.js";
import { withRetry } from "../../src/events/retry.js";
import { RedisEventTransport } from "../../src/events/transports/redis.js";

const redisUrl = process.env.UPSTASH_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

function makeRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeRedis("Upstash Redis — retry + DLQ auto-routing (v2.9)", () => {
  let redis: Redis;
  let transport: RedisEventTransport;
  const channel = `arc-test-retry-dlq-${runId}`;

  beforeAll(async () => {
    redis = makeRedis(redisUrl!);
    transport = new RedisEventTransport(redis, { channel, externalLifecycle: true });

    // Fail fast if we can't reach Upstash
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`Unexpected ping: ${pong}`);
  }, 30_000);

  afterAll(async () => {
    await transport.close();
    redis.disconnect();
  });

  it("idempotencyKey + source survive the Redis pub/sub round-trip", async () => {
    const received: DomainEvent[] = [];
    const unsub = await transport.subscribe("order.*", async (e) => void received.push(e));
    // Upstash pub/sub needs a moment for the subscribe ack to settle.
    await new Promise((r) => setTimeout(r, 250));

    await transport.publish(
      createEvent(
        "order.placed",
        { orderId: "o-int-1" },
        {
          idempotencyKey: "refund:o-int-1:1",
          source: "commerce",
          correlationId: "trace-int-1",
          aggregate: { type: "order", id: "o-int-1" },
        },
      ),
    );

    await waitFor(() => received.length > 0, { timeoutMs: 5_000 });
    unsub();

    expect(received).toHaveLength(1);
    const delivered = received[0]!;
    expect(delivered.meta.idempotencyKey).toBe("refund:o-int-1:1");
    expect(delivered.meta.source).toBe("commerce");
    expect(delivered.meta.correlationId).toBe("trace-int-1");
    expect(delivered.meta.aggregate).toEqual({ type: "order", id: "o-int-1" });
  }, 20_000);

  it("handlers wrapped with withRetry({ transport: dlqSink }) auto-route on exhaustion", async () => {
    // An app-owned transport with a native `deadLetter()` sink. In prod this
    // would be Kafka's DLQ topic, SQS DLQ, etc. — we just need something
    // implementing the optional `deadLetter` method.
    const dlqInbox: DeadLetteredEvent[] = [];
    const dlqSink: Pick<EventTransport, "deadLetter"> = {
      deadLetter: async (dlq) => void dlqInbox.push(dlq),
    };

    const received: DomainEvent[] = [];
    let handlerInvocations = 0;

    const flakyHandler = withRetry(
      async (event) => {
        handlerInvocations += 1;
        received.push(event);
        throw new Error(`downstream-timeout #${handlerInvocations}`);
      },
      {
        maxRetries: 2, // 3 total attempts
        backoffMs: 10, // keep the test fast
        jitter: 0,
        transport: dlqSink,
        name: "refundProcessor",
        logger: { warn: () => {}, error: () => {} },
      },
    );

    const unsub = await transport.subscribe("refund.requested", flakyHandler);
    await new Promise((r) => setTimeout(r, 250));

    const event = createEvent(
      "refund.requested",
      { orderId: "o-int-2", amount: 100 },
      {
        idempotencyKey: "refund:o-int-2:1",
        source: "commerce",
        aggregate: { type: "order", id: "o-int-2" },
      },
    );
    await transport.publish(event);

    await waitFor(() => dlqInbox.length > 0, { timeoutMs: 10_000 });
    unsub();

    expect(handlerInvocations).toBe(3); // initial + 2 retries
    expect(dlqInbox).toHaveLength(1);

    const dl = dlqInbox[0]!;
    expect(dl.event.type).toBe("refund.requested");
    expect(dl.event.meta.idempotencyKey).toBe("refund:o-int-2:1"); // survives DLQ
    expect(dl.event.meta.source).toBe("commerce");
    expect(dl.event.meta.aggregate).toEqual({ type: "order", id: "o-int-2" });
    expect(dl.attempts).toBe(3);
    expect(dl.handlerName).toBe("refundProcessor");
    expect(dl.error.message).toMatch(/downstream-timeout/);
    expect(dl.firstFailedAt).toBeInstanceOf(Date);
    expect(dl.lastFailedAt).toBeInstanceOf(Date);
    expect(dl.lastFailedAt.getTime()).toBeGreaterThanOrEqual(dl.firstFailedAt.getTime());
  }, 20_000);
});
