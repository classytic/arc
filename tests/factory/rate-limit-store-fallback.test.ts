/**
 * `rateLimit.storeFallback` — a shared rate-limit store that is down never hangs or fails the
 * API, and never makes it unlimited.
 *
 * Before: `@fastify/rate-limit` with `redis` waited on the client (ioredis queues commands while
 * it reconnects; `maxRetriesPerRequest: null` queues them forever) or, once the command failed,
 * answered 500 to every request (`skipOnError: false`). Now every store call is bounded and an
 * error or timeout is answered from per-instance memory counters; the shared store is probed
 * again and resumes on its first answer.
 *
 * The fake Redis drives `@fastify/rate-limit`'s REAL RedisStore (it only needs `defineCommand`
 * and the defined command); one case uses a real ioredis client against a port nothing listens on.
 */
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";
import { resolveResourceRateLimiter } from "../../src/permissions/resourceRateLimit.js";

type Mode = "ok" | "error" | "hang";

/** Just enough of ioredis for `@fastify/rate-limit`'s RedisStore: a fixed-window INCR in memory. */
function fakeRedis() {
  const counts = new Map<string, { current: number; expires: number }>();
  const state = { mode: "ok" as Mode, calls: 0 };
  const client: Record<string, unknown> = {
    defineCommand(name: string) {
      client[name] = (key: string, timeWindow: number, ...rest: unknown[]) => {
        const cb = rest.at(-1) as (err: Error | null, res?: [number, number]) => void;
        state.calls++;
        if (state.mode === "hang") return;
        if (state.mode === "error") return cb(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
        const now = Date.now();
        let slot = counts.get(key);
        if (!slot || slot.expires <= now) {
          slot = { current: 0, expires: now + timeWindow };
          counts.set(key, slot);
        }
        slot.current++;
        cb(null, [slot.current, slot.expires - now]);
      };
    },
  };
  return { client, state, counts };
}

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

async function buildApp(rateLimit: Record<string, unknown>) {
  const lines: string[] = [];
  const statuses: Array<{ mode: string; outages: number }> = [];
  const app = await createApp({
    preset: "testing",
    auth: false,
    logger: { level: "info", stream: { write: (line: string) => void lines.push(line) } } as never,
    rateLimit: {
      max: 3,
      timeWindow: "1 minute",
      ...rateLimit,
      ...(rateLimit.storeFallback === false
        ? {}
        : {
            storeFallback: {
              timeoutMs: 100,
              retryAfterMs: 60,
              ...(rateLimit.storeFallback as object | undefined),
              onStatus: (s: { mode: string; outages: number }) => statuses.push(s),
            },
          }),
    },

    plugins: async (f) => {
      f.get("/ping", async () => ({ ok: true }));
      f.get("/strict", { config: { rateLimit: { max: 1, timeWindow: "1 minute" } } }, async () => ({
        ok: true,
      }));
    },
  });
  await app.ready();
  apps.push(app);
  const warnings = () => lines.filter((l) => l.includes("rate-limit store unavailable"));
  const recoveries = () => lines.filter((l) => l.includes("rate-limit store recovered"));
  return { app, statuses, warnings, recoveries };
}

const ping = (app: Awaited<ReturnType<typeof buildApp>>["app"], url = "/ping") =>
  app.inject({ method: "GET", url, headers: { "x-forwarded-for": "198.51.100.7" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("rateLimit.storeFallback", () => {
  it("Redis down at boot: requests answer at once, still limited, one warning", async () => {
    const redis = new Redis("redis://127.0.0.1:6399/0", {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    redis.on("error", () => {});
    try {
      const { app, statuses, warnings } = await buildApp({ redis });
      const started = Date.now();
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await ping(app)).statusCode);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
      // Never a hang: five requests in well under one store timeout each plus slack.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(warnings()).toHaveLength(1);
      expect(statuses.map((s) => s.mode)).toEqual(["fallback"]);
    } finally {
      redis.disconnect();
    }
  });

  it("Redis dropped mid-run: falls back with a limit, then recovers to the shared counts", async () => {
    const fake = fakeRedis();
    const { app, statuses, warnings, recoveries } = await buildApp({ redis: fake.client });

    expect((await ping(app)).statusCode).toBe(200);
    expect(fake.counts.size).toBe(1); // counted in the shared store

    fake.state.mode = "error";
    const during = [];
    for (let i = 0; i < 5; i++) during.push((await ping(app)).statusCode);
    // The fallback starts its own window: 3 allowed, then refused. Never unlimited, never 500.
    expect(during).toEqual([200, 200, 200, 429, 429]);
    expect(warnings()).toHaveLength(1);

    // Degraded: the shared store is not called again until the retry interval passes.
    const callsWhileOpen = fake.state.calls;
    await ping(app);
    expect(fake.state.calls).toBe(callsWhileOpen);

    fake.state.mode = "ok";
    await sleep(80);
    const after = await ping(app);
    expect(after.statusCode).toBe(200); // shared count: 2 of 3
    expect(after.headers["x-ratelimit-remaining"]).toBe("1");
    expect(recoveries()).toHaveLength(1);
    expect(statuses.map((s) => s.mode)).toEqual(["fallback", "shared"]);
    expect(statuses[1]?.outages).toBe(1);
  });

  it("a store that never answers is cut off by the timeout", async () => {
    const fake = fakeRedis();
    fake.state.mode = "hang";
    const { app, warnings } = await buildApp({
      redis: fake.client,
      storeFallback: { timeoutMs: 50 },
    });
    const started = Date.now();
    const res = await ping(app);
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warnings()).toHaveLength(1);
  });

  it("route-level limits fall back too, with their own budget", async () => {
    const fake = fakeRedis();
    fake.state.mode = "error";
    const { app } = await buildApp({ redis: fake.client });
    expect((await ping(app, "/strict")).statusCode).toBe(200);
    expect((await ping(app, "/strict")).statusCode).toBe(429);
    expect((await ping(app)).statusCode).toBe(200);
  });

  it("a custom store gets the same fallback", async () => {
    let failing = true;
    class FlakyStore {
      incr(_key: string, cb: (err: Error | null, res?: { current: number; ttl: number }) => void) {
        if (failing) cb(new Error("store down"));
        else cb(null, { current: 1, ttl: 60_000 });
      }
      child() {
        return new FlakyStore();
      }
    }
    const { app, statuses } = await buildApp({ store: FlakyStore });
    expect((await ping(app)).statusCode).toBe(200);
    expect(statuses.map((s) => s.mode)).toEqual(["fallback"]);
    failing = false;
    await sleep(80);
    expect((await ping(app)).statusCode).toBe(200);
    expect(statuses.map((s) => s.mode)).toEqual(["fallback", "shared"]);
  });

  it("the resource limiter stays SHARED-durable and falls back with its budget intact", async () => {
    const fake = fakeRedis();
    fake.state.mode = "error";
    const { app } = await buildApp({ redis: fake.client });
    const limiter = resolveResourceRateLimiter(app);
    expect(limiter?.durability).toBe("shared");
    const policy = { max: 2, timeWindow: "1 minute" };
    const ctx = { ip: "198.51.100.9" };
    const allowed = [];
    for (let i = 0; i < 3; i++)
      allowed.push((await limiter?.consume("pins", policy, ctx))?.allowed);
    expect(allowed).toEqual([true, true, false]);
  });

  it("storeFallback: false keeps the plugin's own behaviour (a failing store fails the request)", async () => {
    const fake = fakeRedis();
    fake.state.mode = "error";
    const { app } = await buildApp({ redis: fake.client, storeFallback: false });
    expect((await ping(app)).statusCode).toBe(500);
  });

  it("refuses a non-positive timeout", async () => {
    const fake = fakeRedis();
    await expect(buildApp({ redis: fake.client, storeFallback: { timeoutMs: 0 } })).rejects.toThrow(
      /storeFallback\.timeoutMs/,
    );
  });
});
