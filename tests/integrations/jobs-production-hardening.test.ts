/**
 * Jobs Plugin — Production Hardening Contracts
 *
 * Pins the second wave of BullMQ best-practice requirements surfaced by the
 * `bullmq-specialist` and `redis-development` skills audits:
 *
 *   1. Repeatable/cron jobs require an explicit `tz` — DST drift protection
 *   2. `repeat` upserts a scheduled job on plugin register
 *   3. Large payload warning when dispatch() data exceeds 100 KB
 *   4. ioredis connection with missing `maxRetriesPerRequest: null` warns
 *
 * Uses vi.mock('bullmq') + a fake logger so we can assert on warnings.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import eventPlugin from "../../src/events/eventPlugin.js";
import { defineJob, jobsPlugin } from "../../src/integrations/jobs.js";

// ── BullMQ capture state ──
const queueAddCalls: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];

vi.mock("bullmq", () => {
  class Queue {
    constructor(
      public name: string,
      public opts: unknown,
    ) {}
    add = vi.fn(async (name: string, data: unknown, opts: Record<string, unknown>) => {
      queueAddCalls.push({ name, data, opts });
      return { id: `job-${queueAddCalls.length}` };
    });
    getJobCounts = vi.fn(async () => ({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }));
    close = vi.fn(async () => {});
  }

  class Worker {
    constructor(
      public name: string,
      _processor: unknown,
      _opts: unknown,
    ) {}
    on = vi.fn();
    pause = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }

  return { Queue, Worker };
});

// ── Helper: fake fastify logger so we can assert warn calls ──

function makeFastifyWithSpyLogger(): {
  app: FastifyInstance;
  warnSpy: ReturnType<typeof vi.fn>;
} {
  const warnSpy = vi.fn();
  const app = Fastify({
    logger: false,
  });
  // Replace the log with a spyable version on the outer instance.
  Object.defineProperty(app, "log", {
    value: {
      warn: warnSpy,
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: () => app.log,
    },
    writable: false,
    configurable: true,
  });
  return { app, warnSpy };
}

describe("jobsPlugin — production hardening", () => {
  beforeEach(() => {
    queueAddCalls.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────
  // Repeatable/cron validation
  // ────────────────────────────────────────────────────────────────

  describe("repeatable job validation", () => {
    it("rejects a cron pattern without an explicit timezone", async () => {
      const job = defineJob({
        name: "daily-digest",
        handler: async () => ({ ok: true }),
        repeat: { pattern: "0 9 * * *" }, // missing tz
      });

      const fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin);
      await expect(
        fastify.register(jobsPlugin, {
          connection: { host: "localhost", port: 6379 },
          jobs: [job],
        }),
      ).rejects.toThrow(/timezone/i);
      await fastify.close();
    });

    it("rejects setting both pattern and every on the same job", async () => {
      const job = defineJob({
        name: "conflicted",
        handler: async () => ({ ok: true }),
        repeat: { pattern: "0 * * * *", tz: "UTC", every: 60_000 },
      });

      const fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin);
      await expect(
        fastify.register(jobsPlugin, {
          connection: { host: "localhost", port: 6379 },
          jobs: [job],
        }),
      ).rejects.toThrow(/pattern.*every|one/i);
      await fastify.close();
    });

    it("rejects a repeat block with neither pattern nor every", async () => {
      const job = defineJob({
        name: "empty-repeat",
        handler: async () => ({ ok: true }),
        repeat: { tz: "UTC" },
      });

      const fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin);
      await expect(
        fastify.register(jobsPlugin, {
          connection: { host: "localhost", port: 6379 },
          jobs: [job],
        }),
      ).rejects.toThrow(/pattern or every/i);
      await fastify.close();
    });

    it("upserts the repeat schedule at register time with tz preserved", async () => {
      const job = defineJob({
        name: "digest",
        handler: async () => ({ ok: true }),
        repeat: { pattern: "0 9 * * *", tz: "America/New_York" },
      });

      const fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin);
      await fastify.register(jobsPlugin, {
        connection: { host: "localhost", port: 6379 },
        jobs: [job],
      });
      await fastify.ready();

      // The first add() is the repeat upsert.
      const upsert = queueAddCalls.find((c) => c.opts?.repeat);
      expect(upsert).toBeDefined();
      expect(upsert?.opts.repeat).toMatchObject({
        pattern: "0 9 * * *",
        tz: "America/New_York",
      });

      await fastify.close();
    });

    it("supports interval repeats via `every`", async () => {
      const job = defineJob({
        name: "heartbeat",
        handler: async () => ({ ok: true }),
        repeat: { every: 30_000 },
      });

      const fastify = Fastify({ logger: false });
      await fastify.register(eventPlugin);
      await fastify.register(jobsPlugin, {
        connection: { host: "localhost", port: 6379 },
        jobs: [job],
      });
      await fastify.ready();

      const upsert = queueAddCalls.find((c) => c.opts?.repeat);
      expect(upsert).toBeDefined();
      expect(upsert?.opts.repeat).toMatchObject({ every: 30_000 });
      expect((upsert?.opts.repeat as { pattern?: string }).pattern).toBeUndefined();

      await fastify.close();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Large payload warning
  // ────────────────────────────────────────────────────────────────

  describe("large payload warning", () => {
    it("warns when dispatched data exceeds 100 KB", async () => {
      const job = defineJob<{ blob: string }>({
        name: "heavy",
        handler: async () => ({ ok: true }),
      });

      const { app, warnSpy } = makeFastifyWithSpyLogger();
      await app.register(eventPlugin);
      await app.register(jobsPlugin, {
        connection: { host: "localhost", port: 6379 },
        jobs: [job],
      });
      await app.ready();

      // ~120 KB of inline data.
      const payload = { blob: "x".repeat(120 * 1024) };
      await app.jobs.dispatch("heavy", payload);

      const calls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(calls.some((c) => /Large job payload/i.test(c))).toBe(true);

      await app.close();
    });

    it("does NOT warn for small payloads", async () => {
      const job = defineJob({
        name: "light",
        handler: async () => ({ ok: true }),
      });

      const { app, warnSpy } = makeFastifyWithSpyLogger();
      await app.register(eventPlugin);
      await app.register(jobsPlugin, {
        connection: { host: "localhost", port: 6379 },
        jobs: [job],
      });
      await app.ready();

      await app.jobs.dispatch("light", { id: "o-1", type: "noop" });

      const calls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(calls.some((c) => /Large job payload/i.test(c))).toBe(false);

      await app.close();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ioredis config auto-detection
  // ────────────────────────────────────────────────────────────────

  describe("ioredis connection check", () => {
    it("warns when an ioredis-like connection lacks maxRetriesPerRequest: null", async () => {
      // Simulate `new Redis(url)` — has `options` with defaults.
      const fakeIoredis = {
        options: { maxRetriesPerRequest: 20 }, // ioredis default
      };

      const job = defineJob({
        name: "ioredis-naive",
        handler: async () => ({ ok: true }),
      });

      const { app, warnSpy } = makeFastifyWithSpyLogger();
      await app.register(eventPlugin);
      await app.register(jobsPlugin, {
        connection: fakeIoredis as unknown as { host: string; port: number },
        jobs: [job],
      });
      await app.ready();

      const calls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(calls.some((c) => /maxRetriesPerRequest/i.test(c))).toBe(true);

      await app.close();
    });

    it("does NOT warn when maxRetriesPerRequest is null", async () => {
      const fakeIoredis = {
        options: { maxRetriesPerRequest: null },
      };

      const job = defineJob({
        name: "ioredis-proper",
        handler: async () => ({ ok: true }),
      });

      const { app, warnSpy } = makeFastifyWithSpyLogger();
      await app.register(eventPlugin);
      await app.register(jobsPlugin, {
        connection: fakeIoredis as unknown as { host: string; port: number },
        jobs: [job],
      });
      await app.ready();

      const calls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(calls.some((c) => /maxRetriesPerRequest/i.test(c))).toBe(false);

      await app.close();
    });

    it("does NOT warn for a plain options object (non-ioredis shape)", async () => {
      const job = defineJob({
        name: "plain-opts",
        handler: async () => ({ ok: true }),
      });

      const { app, warnSpy } = makeFastifyWithSpyLogger();
      await app.register(eventPlugin);
      await app.register(jobsPlugin, {
        // No `options` field — just host/port
        connection: { host: "localhost", port: 6379 },
        jobs: [job],
      });
      await app.ready();

      const calls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(calls.some((c) => /maxRetriesPerRequest/i.test(c))).toBe(false);

      await app.close();
    });
  });
});
