import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryResourceRateLimiter,
  resolveResourceRateLimiter,
  resourceRateLimitWindowMs,
} from "../../src/permissions/resourceRateLimit.js";

afterEach(() => vi.restoreAllMocks());

it("fails closed at memory capacity without evicting live budgets, and reclaims expired slots", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const limiter = createMemoryResourceRateLimiter(1);
  const policy = { max: 1, timeWindow: "1 second" };
  expect((await limiter.consume("orders", policy, { ip: "a" })).allowed).toBe(true);
  expect((await limiter.consume("orders", policy, { ip: "b" })).allowed).toBe(false);
  expect((await limiter.consume("orders", policy, { ip: "a" })).allowed).toBe(false);
  now += 1000;
  expect((await limiter.consume("orders", policy, { ip: "b" })).allowed).toBe(true);
});

it("shares counters across app instances with a shared SDK store and isolates policies", async () => {
  const counters = new Map<string, number>();
  class SharedStore {
    incr(key: string, cb: (err: Error | null, value: { current: number; ttl: number }) => void) {
      const current = (counters.get(key) ?? 0) + 1;
      counters.set(key, current);
      cb(null, { current, ttl: 60000 });
    }
    child() {
      return new SharedStore();
    }
  }
  const appOne = Fastify();
  const appTwo = Fastify();
  const apps = [appOne, appTwo];
  try {
    for (const app of apps) await app.register(rateLimit, { global: false, store: SharedStore });
    const first = resolveResourceRateLimiter(appOne, "shared");
    const second = resolveResourceRateLimiter(appTwo, "shared");
    if (!first || !second) throw new Error("test rate limiter registration failed");
    const policy = { max: 1, timeWindow: "1 minute" };
    expect((await first.consume("orders", policy, { ip: "a" })).allowed).toBe(true);
    const denied = await second.consume("orders", policy, { ip: "a" });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(60);
    expect(
      (await second.consume("orders", { ...policy, bucket: "route:GET:/preview" }, { ip: "a" }))
        .allowed,
    ).toBe(true);
    expect(counters.size).toBe(2);
  } finally {
    await Promise.all(apps.map((app) => app.close()));
  }
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid memory capacity %s",
  (capacity) => {
    expect(() => createMemoryResourceRateLimiter(capacity)).toThrow("capacity");
  },
);
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid max %s before consuming",
  async (max) => {
    await expect(
      createMemoryResourceRateLimiter().consume("orders", { max, timeWindow: "1m" }, {}),
    ).rejects.toThrow("max");
  },
);
it.each([
  ["1m", 60000],
  ["1ms", 1],
  ["1.5 seconds", 1500],
  ["2w", 1209600000],
])("accepts SDK duration %s", (window, expected) => {
  expect(resourceRateLimitWindowMs(String(window))).toBe(expected);
});
