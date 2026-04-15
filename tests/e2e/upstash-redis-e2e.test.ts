/**
 * End-to-end distributed-system test against real Upstash Redis.
 *
 * Validates arc's readiness for distributed architectures by exercising
 * every layer of the event + job-queue stack against a live Redis endpoint:
 *
 *   1. Pub/Sub transport — single-process delivery, pattern filtering
 *   2. Pub/Sub transport — cross-instance fan-out (two Fastify apps on one channel)
 *   3. Streams transport — consumer-group at-least-once delivery
 *   4. Event metadata — correlationId/userId/organizationId round-trip
 *   5. defineEvent + registry validation (reject mode)
 *   6. Retry + $deadLetter — handler failures exhaust retries and flow to DLQ
 *   7. BullMQ jobsPlugin — dispatch, bridged completion event, stats
 *   8. BullMQ job failure — retries then dead-letter queue routing
 *
 * Skipped when UPSTASH_REDIS_URL is not set; never fails CI without credentials.
 *
 * Run:
 *   npm run test:e2e -- tests/e2e/upstash-redis-e2e.test.ts
 */

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventRegistry, defineEvent } from "../../src/events/defineEvent.js";
import { createEvent, type DomainEvent } from "../../src/events/EventTransport.js";
import eventPlugin from "../../src/events/eventPlugin.js";
import { RedisEventTransport } from "../../src/events/transports/redis.js";
import { RedisStreamTransport } from "../../src/events/transports/redis-stream.js";
import { defineJob, jobsPlugin } from "../../src/integrations/jobs.js";

const redisUrl = process.env.UPSTASH_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

/** ioredis tuned for Upstash + BullMQ. */
function makeRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

/** Poll until `predicate()` is truthy or we exceed `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Unique suffix per run so parallel/rerun tests don't collide. */
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeRedis("Upstash Redis — arc distributed-system readiness", () => {
  beforeAll(async () => {
    const probe = makeRedis(redisUrl!);
    try {
      const pong = await probe.ping();
      if (pong !== "PONG") throw new Error(`Unexpected ping: ${pong}`);
    } finally {
      probe.disconnect();
    }
  }, 30_000);

  // ────────────────────────────────────────────────────────────────────
  // 1. Pub/Sub — single process
  // ────────────────────────────────────────────────────────────────────

  describe("pub/sub — single process", () => {
    let redis: Redis;
    let transport: RedisEventTransport;
    const channel = `arc-test-pubsub-${runId}`;

    beforeAll(async () => {
      redis = makeRedis(redisUrl!);
      transport = new RedisEventTransport(redis, { channel, externalLifecycle: true });
    });
    afterAll(async () => {
      await transport.close();
      redis.disconnect();
    });

    it("delivers to a matching pattern subscriber", async () => {
      const received: DomainEvent[] = [];
      const unsub = await transport.subscribe("order.*", async (e) => void received.push(e));
      await new Promise((r) => setTimeout(r, 200));

      await transport.publish(createEvent("order.created", { orderId: "o-1" }));
      await waitFor(() => received.length > 0, { timeoutMs: 5_000 });
      unsub();

      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe("order.created");
    }, 15_000);

    it("does not deliver non-matching events", async () => {
      const received: DomainEvent[] = [];
      const unsub = await transport.subscribe("billing.*", async (e) => void received.push(e));
      await new Promise((r) => setTimeout(r, 200));
      await transport.publish(createEvent("order.shipped", { orderId: "o-2" }));
      await new Promise((r) => setTimeout(r, 500));
      unsub();
      expect(received).toHaveLength(0);
    }, 15_000);
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. Pub/Sub — two Fastify instances sharing a channel
  //    (proves cross-service event bus)
  // ────────────────────────────────────────────────────────────────────

  describe("pub/sub — cross-instance fan-out", () => {
    let publisher: FastifyInstance;
    let subscriber: FastifyInstance;
    let pubRedis: Redis;
    let subRedis: Redis;
    const channel = `arc-test-xservice-${runId}`;

    beforeAll(async () => {
      pubRedis = makeRedis(redisUrl!);
      subRedis = makeRedis(redisUrl!);

      publisher = Fastify({ logger: false });
      subscriber = Fastify({ logger: false });

      await publisher.register(eventPlugin, {
        transport: new RedisEventTransport(pubRedis, { channel, externalLifecycle: true }),
      });
      await subscriber.register(eventPlugin, {
        transport: new RedisEventTransport(subRedis, { channel, externalLifecycle: true }),
      });

      await Promise.all([publisher.ready(), subscriber.ready()]);
    }, 30_000);

    afterAll(async () => {
      await Promise.all([publisher.close(), subscriber.close()]);
      pubRedis.disconnect();
      subRedis.disconnect();
    });

    it("publisher emits → subscriber receives on a different Fastify instance", async () => {
      const received: DomainEvent[] = [];
      await subscriber.events.subscribe("invoice.*", async (e) => void received.push(e));
      await new Promise((r) => setTimeout(r, 300));

      await publisher.events.publish("invoice.paid", { invoiceId: "inv-1", amount: 100 });
      await waitFor(() => received.length > 0, { timeoutMs: 5_000 });

      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe("invoice.paid");
      expect(received[0]!.payload).toMatchObject({ invoiceId: "inv-1", amount: 100 });
    }, 15_000);

    it("metadata (correlationId/userId/organizationId) round-trips across instances", async () => {
      const received: DomainEvent[] = [];
      await subscriber.events.subscribe("audit.*", async (e) => void received.push(e));
      await new Promise((r) => setTimeout(r, 300));

      await publisher.events.publish(
        "audit.action",
        { action: "login" },
        { correlationId: "trace-xyz", userId: "u-7", organizationId: "org-1" },
      );
      await waitFor(() => received.length > 0, { timeoutMs: 5_000 });

      const meta = received[0]!.meta;
      expect(meta.correlationId).toBe("trace-xyz");
      expect(meta.userId).toBe("u-7");
      expect(meta.organizationId).toBe("org-1");
      expect(typeof meta.id).toBe("string"); // auto-generated UUID
      expect(meta.timestamp).toBeDefined();
    }, 15_000);
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. Streams — consumer-group at-least-once
  // ────────────────────────────────────────────────────────────────────

  describe("streams — consumer group at-least-once", () => {
    let redis: Redis;
    let transport: RedisStreamTransport;
    const stream = `arc-test-stream-${runId}`;

    beforeAll(async () => {
      redis = makeRedis(redisUrl!);
      transport = new RedisStreamTransport(redis, {
        stream,
        group: "test-group",
        consumer: "test-consumer",
        blockTimeMs: 1_000,
        batchSize: 10,
        maxRetries: 2,
        deadLetterStream: false,
      });
    });

    afterAll(async () => {
      await transport.close();
      try {
        await redis.del(stream);
      } catch {
        /* ignore */
      }
      redis.disconnect();
    });

    it("delivers via consumer group and ack-s on success", async () => {
      const received: DomainEvent[] = [];
      const unsub = await transport.subscribe("*", async (e) => void received.push(e));
      await new Promise((r) => setTimeout(r, 300));

      await transport.publish(createEvent("payment.settled", { paymentId: "p-1" }));
      await waitFor(() => received.length > 0, { timeoutMs: 10_000 });
      unsub();

      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe("payment.settled");
    }, 20_000);
  });

  // ────────────────────────────────────────────────────────────────────
  // 4. defineEvent + registry validation
  //    (DX: typed events, schema enforcement on publish)
  // ────────────────────────────────────────────────────────────────────

  describe("defineEvent + registry validation", () => {
    let fastify: FastifyInstance;
    let redis: Redis;
    const channel = `arc-test-registry-${runId}`;

    const UserSignedUp = defineEvent({
      name: "user.signed_up",
      version: 1,
      schema: {
        type: "object",
        properties: {
          userId: { type: "string" },
          email: { type: "string" },
        },
        required: ["userId", "email"],
      },
    });

    beforeAll(async () => {
      redis = makeRedis(redisUrl!);
      const registry = createEventRegistry();
      registry.register(UserSignedUp);

      fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin, {
        transport: new RedisEventTransport(redis, { channel, externalLifecycle: true }),
        registry,
        validateMode: "reject", // invalid payloads must throw, not just warn
      });
      await fastify.ready();
    }, 30_000);

    afterAll(async () => {
      await fastify.close();
      redis.disconnect();
    });

    it("accepts a valid payload and delivers it", async () => {
      const received: DomainEvent[] = [];
      await fastify.events.subscribe("user.signed_up", async (e) => void received.push(e));
      await new Promise((r) => setTimeout(r, 300));

      await fastify.events.publish("user.signed_up", {
        userId: "u-1",
        email: "alice@example.com",
      });
      await waitFor(() => received.length > 0, { timeoutMs: 5_000 });

      expect(received[0]!.payload).toMatchObject({ userId: "u-1", email: "alice@example.com" });
    }, 15_000);

    it("rejects an invalid payload in reject mode", async () => {
      await expect(
        fastify.events.publish("user.signed_up", { userId: "u-2" }), // missing email
      ).rejects.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 5. Retry + $deadLetter flow
  // ────────────────────────────────────────────────────────────────────

  describe("retry + $deadLetter", () => {
    let fastify: FastifyInstance;
    let redis: Redis;
    const channel = `arc-test-dlq-${runId}`;

    beforeAll(async () => {
      redis = makeRedis(redisUrl!);
      fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin, {
        transport: new RedisEventTransport(redis, { channel, externalLifecycle: true }),
        failOpen: false, // surface errors
        retry: { maxRetries: 2, backoffMs: 50, maxBackoffMs: 200, jitter: 0 },
        deadLetterQueue: {}, // default: publish to $deadLetter
      });
      await fastify.ready();
    }, 30_000);

    afterAll(async () => {
      await fastify.close();
      redis.disconnect();
    });

    it("retries a failing handler and routes to $deadLetter after exhaustion", async () => {
      let attempts = 0;
      await fastify.events.subscribe("risky.event", async () => {
        attempts += 1;
        throw new Error("simulated handler failure");
      });

      const dlqReceived: DomainEvent[] = [];
      await fastify.events.subscribe("$deadLetter", async (e) => void dlqReceived.push(e));
      await new Promise((r) => setTimeout(r, 300));

      await fastify.events.publish("risky.event", { reason: "chaos" });

      // Initial try + maxRetries retries = 3 total attempts
      await waitFor(() => attempts >= 3, { timeoutMs: 10_000 });
      await waitFor(() => dlqReceived.length > 0, { timeoutMs: 10_000 });

      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(dlqReceived).toHaveLength(1);
      // DLQ payload wraps the original event + accumulated errors.
      const dlqPayload = dlqReceived[0]!.payload as {
        originalEvent: { type: string };
        errors: unknown[];
      };
      expect(dlqPayload.originalEvent.type).toBe("risky.event");
      expect(Array.isArray(dlqPayload.errors)).toBe(true);
      expect(dlqPayload.errors.length).toBeGreaterThanOrEqual(1);
    }, 30_000);
  });

  // ────────────────────────────────────────────────────────────────────
  // 6. BullMQ jobsPlugin — happy path + event bridging
  // ────────────────────────────────────────────────────────────────────

  describe("jobsPlugin — dispatch + event bridging", () => {
    let fastify: FastifyInstance;
    let redis: Redis;
    const jobName = `arc-test-job-${runId}`;
    const handlerCalls: Array<{ to: string; attempt: number }> = [];

    const sendEmail = defineJob<{ to: string }, { sent: true }>({
      name: jobName,
      handler: async (data, meta) => {
        handlerCalls.push({ to: data.to, attempt: meta.attemptsMade });
        return { sent: true };
      },
      retries: 0,
      concurrency: 1,
    });

    beforeAll(async () => {
      redis = makeRedis(redisUrl!);
      fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin);
      await fastify.register(jobsPlugin, {
        connection: redis,
        jobs: [sendEmail],
        bridgeEvents: true,
      });
      await fastify.ready();
    }, 30_000);

    afterAll(async () => {
      await fastify.close();
      redis.disconnect();
    });

    it("dispatches, runs the worker, and publishes a completion event", async () => {
      const completions: DomainEvent[] = [];
      await fastify.events.subscribe(
        `job.${jobName}.completed`,
        async (e) => void completions.push(e),
      );

      const { jobId } = await fastify.jobs.dispatch(jobName, { to: "alice@example.com" });
      expect(jobId).toBeTruthy();

      await waitFor(() => handlerCalls.length > 0, { timeoutMs: 15_000 });
      expect(handlerCalls[0]).toEqual({ to: "alice@example.com", attempt: 0 });

      await waitFor(() => completions.length > 0, { timeoutMs: 5_000 });
      expect(completions[0]!.type).toBe(`job.${jobName}.completed`);
    }, 30_000);

    it("exposes queue stats via fastify.jobs.getStats()", async () => {
      const stats = await fastify.jobs.getStats();
      expect(stats[jobName]).toBeDefined();
      expect(typeof stats[jobName]!.completed).toBe("number");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 7. BullMQ — failure + dead-letter queue
  // ────────────────────────────────────────────────────────────────────

  describe("jobsPlugin — retries + dead-letter queue", () => {
    let fastify: FastifyInstance;
    let redis: Redis;
    const jobName = `arc-test-job-fail-${runId}`;
    const dlqName = `${jobName}-dead`;
    let attempts = 0;

    const flakyJob = defineJob<{ id: string }, never>({
      name: jobName,
      handler: async () => {
        attempts += 1;
        throw new Error("always fails");
      },
      // Arc's `retries` is mapped to BullMQ's `attempts` (total runs, not
      // retries on top of the initial). 2 here = 2 total attempts.
      retries: 2,
      deadLetterQueue: dlqName,
      concurrency: 1,
    });

    beforeAll(async () => {
      redis = makeRedis(redisUrl!);
      fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin);
      await fastify.register(jobsPlugin, {
        connection: redis,
        jobs: [flakyJob],
        bridgeEvents: true,
      });
      await fastify.ready();
    }, 30_000);

    afterAll(async () => {
      await fastify.close();
      redis.disconnect();
    });

    it("retries then publishes a job.*.failed event and routes to DLQ", async () => {
      const failures: DomainEvent[] = [];
      await fastify.events.subscribe(`job.${jobName}.failed`, async (e) => void failures.push(e));

      await fastify.jobs.dispatch(jobName, { id: "x-1" });

      // Initial + 1 retry = 2 invocations.
      await waitFor(() => attempts >= 2, { timeoutMs: 20_000 });
      await waitFor(() => failures.length > 0, { timeoutMs: 10_000 });

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(failures[0]!.type).toBe(`job.${jobName}.failed`);

      // Verify DLQ received the job via a direct Redis scan (bullmq prefix).
      const keys = await redis.keys(`bull:${dlqName}:*`);
      expect(keys.length).toBeGreaterThan(0);
    }, 45_000);
  });
});
