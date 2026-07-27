/**
 * requireQuota (2.22) — use-case suite over a REAL app: a metered
 * "export" action gated by quota, exercised over the wire.
 *
 * Pins the full policy matrix: under/at/over the ceiling (429 with the
 * client-renderable meta: used/limit/period/resetsAt), plan-aware limit
 * resolvers, `false` = unlimited (skips the read), per-actor isolation,
 * fail-OPEN on store read failure (default) vs `'deny'` (503), loud 500
 * when usagePlugin is missing, and the check-then-act boundary.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionCheck } from "../../src/permissions/types.js";
import type { UsageStore } from "../../src/usage/index.js";
import usagePlugin, { MemoryUsageStore, requireQuota } from "../../src/usage/index.js";

const apps: Array<{ close(): Promise<void> }> = [];

/**
 * Minimal metered endpoint: the gate runs as preHandler (same
 * position arc's permission middleware occupies), then the handler
 * records one export run — the canonical check-then-act shape.
 */
async function buildMeteredApp(opts: {
  gate: PermissionCheck;
  store?: UsageStore;
  registerUsage?: boolean;
}) {
  const app = Fastify({ logger: false });
  if (opts.registerUsage !== false) {
    await app.register(usagePlugin, {
      store: opts.store ?? new MemoryUsageStore(),
      track: { requests: false },
    });
  }
  app.post(
    "/exports",
    {
      preHandler: async (req, reply) => {
        try {
          const ok = await opts.gate({
            user: null,
            request: req,
            resource: "export",
            action: "create",
          });
          if (ok !== true) return reply.code(403).send({ code: "forbidden" });
        } catch (err) {
          const e = err as {
            statusCode?: number;
            code?: string;
            details?: unknown;
            message: string;
          };
          return reply
            .code(e.statusCode ?? 500)
            .send({ code: e.code, message: e.message, meta: e.details });
        }
      },
    },
    async (req) => {
      await req.server.usage?.record(`ip:${req.ip}`, "export.runs", 1);
      return { exported: true };
    },
  );
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

describe("requireQuota — the metered-export use case", () => {
  it("allows under the ceiling, blocks at it with a client-renderable 429", async () => {
    const app = await buildMeteredApp({
      gate: requireQuota({ kind: "export.runs", limit: 2 }),
    });

    expect((await app.inject({ method: "POST", url: "/exports" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/exports" })).statusCode).toBe(200);

    const blocked = await app.inject({ method: "POST", url: "/exports" });
    expect(blocked.statusCode).toBe(429);
    const body = JSON.parse(blocked.body);
    expect(body.code).toBe("quota.exceeded");
    expect(body.meta).toMatchObject({ kind: "export.runs", used: 2, limit: 2 });
    expect(body.meta.period).toMatch(/^\d{4}-\d{2}$/);
    expect(new Date(body.meta.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("plan-aware limits: the resolver decides per request", async () => {
    const PLAN_QUOTAS: Record<string, number | false> = { free: 1, enterprise: false };
    const app = await buildMeteredApp({
      gate: requireQuota({
        kind: "export.runs",
        limit: (ctx) => PLAN_QUOTAS[String(ctx.request.headers["x-plan"])] ?? 1,
      }),
    });

    const free = { "x-plan": "free" };
    expect((await app.inject({ method: "POST", url: "/exports", headers: free })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "POST", url: "/exports", headers: free })).statusCode).toBe(
      429,
    );

    // Unlimited plan sails through — same bucket, no ceiling.
    const ent = { "x-plan": "enterprise" };
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "POST", url: "/exports", headers: ent })).statusCode).toBe(
        200,
      );
    }
  });

  it("quota reads the same buckets usage writes (actor isolation)", async () => {
    const store = new MemoryUsageStore();
    const app = await buildMeteredApp({
      store,
      gate: requireQuota({ kind: "export.runs", limit: 1 }),
    });

    // Another actor's consumption never counts against this one.
    store.increment({ actor: "someone-else", period: currentPeriod(), kind: "export.runs" }, 999);
    expect((await app.inject({ method: "POST", url: "/exports" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/exports" })).statusCode).toBe(429);
  });

  it("fail-OPEN by default when the counter store is down; 'deny' flips to 503", async () => {
    const broken: UsageStore = {
      name: "broken",
      increment: () => undefined,
      summary: async () => {
        throw new Error("store down");
      },
    };

    const open = await buildMeteredApp({
      store: broken,
      gate: requireQuota({ kind: "export.runs", limit: 0 }), // limit 0 would block if readable
    });
    expect((await open.inject({ method: "POST", url: "/exports" })).statusCode).toBe(200);

    const closed = await buildMeteredApp({
      store: broken,
      gate: requireQuota({ kind: "export.runs", limit: 0, onStoreError: "deny" }),
    });
    const res = await closed.inject({ method: "POST", url: "/exports" });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe("quota.unavailable");
  });

  it("missing usagePlugin is a LOUD 500 misconfiguration, never a silent no-op", async () => {
    const app = await buildMeteredApp({
      gate: requireQuota({ kind: "export.runs", limit: 10 }),
      registerUsage: false,
    });
    const res = await app.inject({ method: "POST", url: "/exports" });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).code).toBe("quota.meter_missing");
  });

  it("micro-cache serves the memoized read inside the TTL window", async () => {
    let reads = 0;
    const store = new MemoryUsageStore();
    const counting: UsageStore = {
      name: "counting",
      increment: (b, n) => store.increment(b, n),
      summary: (a, p) => {
        reads += 1;
        return store.summary(a, p);
      },
    };
    const app = await buildMeteredApp({
      store: counting,
      gate: requireQuota({ kind: "export.runs", limit: 100, cacheTtlMs: 60_000 }),
    });

    await app.inject({ method: "POST", url: "/exports" });
    await app.inject({ method: "POST", url: "/exports" });
    await app.inject({ method: "POST", url: "/exports" });
    expect(reads).toBe(1); // one real read, two memo hits
  });
});

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
