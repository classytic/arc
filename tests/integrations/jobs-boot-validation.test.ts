/**
 * Jobs plugin — boot-time validation and management-route security.
 *
 * Every failure here is unrecoverable at runtime, so it must be raised BEFORE a
 * single BullMQ object exists: allocating queues and workers first would leave
 * live Redis connections behind when the plugin throws.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineJob, jobsPlugin } from "../../src/integrations/jobs/index.js";
import { normalizeToDecision } from "../../src/permissions/authorizationDecision.js";
import { requireOrgRole, requirePlatformRole, requireRoles } from "../../src/permissions/index.js";

const constructed: { queues: string[]; workers: string[] } = { queues: [], workers: [] };

vi.mock("bullmq", () => {
  class Queue {
    constructor(public name: string) {
      constructed.queues.push(name);
    }
    add = vi.fn(async () => ({ id: "job-1" }));
    getJobCounts = vi.fn(async () => ({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }));
    getJob = vi.fn(async (id: string) =>
      id === "known"
        ? {
            id,
            progress: 0,
            getState: async () => "completed",
            returnvalue: { secret: "s3cret-export-url" },
            failedReason: undefined,
          }
        : undefined,
    );
    upsertJobScheduler = vi.fn(async () => {});
    getJobSchedulers = vi.fn(async () => []);
    close = vi.fn(async () => {});
  }
  class Worker {
    constructor(public name: string) {
      constructed.workers.push(name);
    }
    on = vi.fn();
    pause = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }
  return { Queue, Worker };
});

const noop = async () => ({});
const conn = { host: "localhost", port: 6379, maxRetriesPerRequest: null };

beforeEach(() => {
  constructed.queues.length = 0;
  constructed.workers.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("jobs — boot validation", () => {
  it("rejects a duplicate job name BEFORE constructing any queue or worker", async () => {
    // Duplicates are silently destructive: the registration loop creates a queue
    // AND a worker per definition and overwrites the map entry, so both workers
    // stay live while only the last is tracked for shutdown.
    const app = Fastify({ logger: false });
    await expect(
      app.register(jobsPlugin, {
        connection: conn,
        jobs: [
          defineJob({ name: "email", handler: noop }),
          defineJob({ name: "email", handler: noop }),
        ],
      }),
    ).rejects.toThrow(/duplicate job name "email"/);

    expect(constructed.queues).toEqual([]);
    expect(constructed.workers).toEqual([]);
    await app.close();
  });

  it.each([
    ["maxConcurrent", 0, /maxConcurrent=0 — must be a positive integer/],
    ["maxConcurrent", 1.5, /maxConcurrent=1\.5 — must be a positive integer/],
    ["concurrency", -1, /concurrency=-1 — must be a positive integer/],
    ["timeout", 0, /timeout=0 — must be a positive integer/],
    ["retries", -1, /retries=-1 — must be a non-negative integer/],
    ["cancelGraceMs", -5, /cancelGraceMs=-5 — must be a non-negative integer/],
  ])("rejects %s=%s at boot", async (field, value, pattern) => {
    // `maxConcurrent <= 0` in particular never releases a semaphore slot: the job
    // waits forever, with no error and no timeout.
    const app = Fastify({ logger: false });
    await expect(
      app.register(jobsPlugin, {
        connection: conn,
        jobs: [defineJob({ name: "j", handler: noop, [field]: value } as never)],
      }),
    ).rejects.toThrow(pattern);
    expect(constructed.queues).toEqual([]);
    await app.close();
  });

  it.each([
    ["defaults.retries", { retries: -1 }, /defaults.retries=-1 — must be a non-negative integer/],
    ["defaults.timeout", { timeout: 0 }, /defaults.timeout=0 — must be a positive integer/],
    [
      "defaults.backoff.delay",
      { backoff: { type: "fixed" as const, delay: -100 } },
      /defaults.backoff.delay=-100 — must be a non-negative integer/,
    ],
  ])(
    "rejects an invalid %s — defaults are inherited by every job that omits the field",
    async (_label, defaults, pattern) => {
      const app = Fastify({ logger: false });
      await expect(
        app.register(jobsPlugin, {
          connection: conn,
          jobs: [defineJob({ name: "j", handler: noop })],
          defaults: defaults as never,
        }),
      ).rejects.toThrow(pattern);
      expect(constructed.queues).toEqual([]);
      await app.close();
    },
  );

  it.each([
    ["repeat.every", { every: 0 }, /repeat.every=0 — must be a positive integer/],
    ["repeat.every", { every: -100 }, /repeat.every=-100 — must be a positive integer/],
    ["repeat.limit", { every: 1000, limit: 0 }, /repeat.limit=0 — must be a positive integer/],
    ["repeat.pattern", { pattern: "   ", tz: "UTC" }, /empty repeat.pattern/],
  ])("rejects an invalid %s", async (_label, repeat, pattern) => {
    // `every: 0` is a busy-loop or a schedule that never fires; `limit: 0`
    // registers a repeatable that is dead on arrival.
    const app = Fastify({ logger: false });
    await expect(
      app.register(jobsPlugin, {
        connection: conn,
        jobs: [defineJob({ name: "j", handler: noop, repeat: repeat as never })],
      }),
    ).rejects.toThrow(pattern);
    expect(constructed.queues).toEqual([]);
    await app.close();
  });

  it("rejects a negative job backoff delay", async () => {
    const app = Fastify({ logger: false });
    await expect(
      app.register(jobsPlugin, {
        connection: conn,
        jobs: [defineJob({ name: "j", handler: noop, backoff: { type: "fixed", delay: -1 } })],
      }),
    ).rejects.toThrow(/backoff.delay=-1 — must be a non-negative integer/);
    await app.close();
  });

  it("rejects an empty job name", async () => {
    const app = Fastify({ logger: false });
    await expect(
      app.register(jobsPlugin, {
        connection: conn,
        jobs: [defineJob({ name: "  ", handler: noop })],
      }),
    ).rejects.toThrow(/empty name/);
    await app.close();
  });
});

describe("jobs — management routes", () => {
  it("mounts NOTHING by default", async () => {
    // A status carries `returnValue` and `failedReason` — the handler's own output
    // and error text. Unauthenticated, a job id becomes a read primitive.
    const app = Fastify({ logger: false });
    await app.register(jobsPlugin, {
      connection: conn,
      jobs: [defineJob({ name: "email", handler: noop })],
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/jobs/stats" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/jobs/email/known/status" })).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it("enforces the permission when enabled, and redacts result + failure by default", async () => {
    const app = Fastify({ logger: false });
    await app.register(jobsPlugin, {
      connection: conn,
      jobs: [defineJob({ name: "email", handler: noop })],
      managementRoutes: { operatorPermission: () => true, allowUnverifiedOperatorPermission: true },
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/jobs/email/known/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe("completed");
    // Opt-in only — the host decides, knowing what its own handlers return.
    expect(body.returnValue).toBeUndefined();
    expect(body).not.toHaveProperty("failedReason");
    await app.close();
  });

  it("denies when the permission refuses", async () => {
    const app = Fastify({ logger: false });
    await app.register(jobsPlugin, {
      connection: conn,
      jobs: [defineJob({ name: "email", handler: noop })],
      managementRoutes: {
        operatorPermission: () => false,
        allowUnverifiedOperatorPermission: true,
      },
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/jobs/stats" });
    expect([401, 403]).toContain(res.statusCode);
    await app.close();
  });

  it.each([
    ["requireOrgRole('manager') — grants ANY org's manager", () => requireOrgRole("manager")],
    [
      "requireRoles(['platform-ops']) — an ORG role of that name satisfies it",
      () => requireRoles(["platform-ops"]),
    ],
  ])("refuses %s at BOOT", async (_label, build) => {
    // Both return a bare allow with NO policy, so no per-request check can tell
    // them apart from a real operator gate — a manager in org A would pass and
    // read a known handle from org B. The guard has to be boot-time and
    // metadata-driven.
    const app = Fastify({ logger: false });
    await expect(
      app.register(jobsPlugin, {
        connection: conn,
        jobs: [defineJob({ name: "email", handler: noop })],
        managementRoutes: { operatorPermission: build() },
      }),
    ).rejects.toThrow(/must be platform-only/);
    await app.close();
  });

  it("accepts requirePlatformRole — it consults platform roles only", async () => {
    const app = Fastify({ logger: false });
    await app.register(jobsPlugin, {
      connection: conn,
      jobs: [defineJob({ name: "email", handler: noop })],
      managementRoutes: { operatorPermission: requirePlatformRole("platform-ops") },
    });
    await app.ready();
    // Mounted, and still gated: no platform role on this caller.
    const res = await app.inject({ method: "GET", url: "/jobs/stats" });
    expect([401, 403]).toContain(res.statusCode);
    await app.close();
  });

  it("an ORG role named platform-ops does NOT satisfy requirePlatformRole", async () => {
    const check = requirePlatformRole("platform-ops");
    const orgOnly = {
      user: { id: "u", role: [] },
      request: {
        scope: {
          kind: "member",
          userId: "u",
          organizationId: "o",
          userRoles: [],
          orgRoles: ["platform-ops"],
        },
      },
      scope: {
        kind: "member",
        userId: "u",
        organizationId: "o",
        userRoles: [],
        orgRoles: ["platform-ops"],
      },
      resource: "jobs",
      action: "read",
    };
    expect(normalizeToDecision(await check(orgOnly as never)).effect).toBe("deny");
  });

  it("REFUSES a permission that returns a row-level policy", async () => {
    // Jobs carry no tenant identity and `getStatus` fetches by queue + id, so a
    // policy has nothing to filter. Accepting it would make requireOrgRole read
    // as tenant-scoped while serving every org's jobs.
    const app = Fastify({ logger: false });
    await app.register(jobsPlugin, {
      connection: conn,
      jobs: [defineJob({ name: "email", handler: noop })],
      managementRoutes: {
        operatorPermission: () => ({ effect: "allow", policy: { orgId: "a" } }),
        allowUnverifiedOperatorPermission: true,
      },
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/jobs/stats" });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("arc.jobs.policy_unsupported");
    await app.close();
  });

  it("status is queue-qualified — an unknown queue is a 404, not a scan", async () => {
    // BullMQ ids are queue-LOCAL, so an id alone cannot identify a job.
    const app = Fastify({ logger: false });
    await app.register(jobsPlugin, {
      connection: conn,
      jobs: [defineJob({ name: "email", handler: noop })],
      managementRoutes: {
        operatorPermission: () => true,
        allowUnverifiedOperatorPermission: true,
        exposeResult: true,
      },
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/jobs/nope/known/status" })).statusCode).toBe(
      404,
    );
    const ok = await app.inject({ method: "GET", url: "/jobs/email/known/status" });
    expect(JSON.parse(ok.body).returnValue).toEqual({ secret: "s3cret-export-url" });
    await app.close();
  });
});
