/**
 * Unit tests for the idempotency store adapter helpers + findByPrefix
 * batching. Fakes both ioredis and @upstash/redis shapes to verify the
 * option-shape translation and Lua-eval bridging.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type IoredisLike,
  ioredisAsIdempotencyClient,
  RedisIdempotencyStore,
  type UpstashRedisLike,
  upstashAsIdempotencyClient,
} from "../../src/idempotency/stores/redis.js";

// ────────────────────────────────────────────────────────────────────────
// ioredis adapter
// ────────────────────────────────────────────────────────────────────────

describe("ioredisAsIdempotencyClient", () => {
  function makeFake(): IoredisLike & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      async get() {
        return null;
      },
      async set(...args) {
        calls.push(["set", ...args]);
        return "OK";
      },
      async del(...keys) {
        calls.push(["del", ...keys]);
        return keys.length;
      },
      async exists(...keys) {
        calls.push(["exists", ...keys]);
        return 1;
      },
      async scan(cursor, ...args) {
        calls.push(["scan", cursor, ...args]);
        return ["0", []];
      },
      eval: vi.fn(async () => 1),
    };
  }

  it("set() with EX + NX — positional flags", async () => {
    const client = makeFake();
    const adapter = ioredisAsIdempotencyClient(client);
    await adapter.set("lock", "req-1", { EX: 30, NX: true });

    const setCall = client.calls.find((c) => c[0] === "set");
    expect(setCall).toEqual(["set", "lock", "req-1", "EX", 30, "NX"]);
  });

  it("exists() with an array spreads into varargs", async () => {
    const client = makeFake();
    const adapter = ioredisAsIdempotencyClient(client);
    await adapter.exists(["a", "b", "c"]);

    const existsCall = client.calls.find((c) => c[0] === "exists");
    expect(existsCall).toEqual(["exists", "a", "b", "c"]);
  });

  it("exposes eval when the underlying client supports it", () => {
    const client = makeFake();
    const adapter = ioredisAsIdempotencyClient(client);
    expect((adapter as { eval?: unknown }).eval).toBeDefined();
  });

  it("omits eval when the underlying client does not support it", () => {
    const client = { ...makeFake(), eval: undefined } as IoredisLike;
    const adapter = ioredisAsIdempotencyClient(client);
    expect((adapter as { eval?: unknown }).eval).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// @upstash/redis adapter
// ────────────────────────────────────────────────────────────────────────

describe("upstashAsIdempotencyClient", () => {
  function makeFake(): UpstashRedisLike & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      async get() {
        return null;
      },
      async set(key, value, opts) {
        calls.push(["set", key, value, opts]);
        return "OK";
      },
      async del(...keys) {
        calls.push(["del", ...keys]);
        return keys.length;
      },
      async exists(...keys) {
        calls.push(["exists", ...keys]);
        return 1;
      },
      async scan(cursor, opts) {
        calls.push(["scan", cursor, opts]);
        return [0, []];
      },
      eval: vi.fn(async () => 1),
    };
  }

  it("set() with EX + NX → lowercase upstash options", async () => {
    const client = makeFake();
    const adapter = upstashAsIdempotencyClient(client);
    await adapter.set("lock", "req-1", { EX: 30, NX: true });

    const setCall = client.calls.find((c) => c[0] === "set")!;
    expect(setCall[3]).toEqual({ ex: 30, nx: true });
  });

  it("get() re-serializes auto-deserialized objects for arc contract", async () => {
    const client: UpstashRedisLike = {
      async get() {
        return { statusCode: 200 } as unknown;
      },
      async set() {
        return "OK";
      },
      async del() {
        return 0;
      },
      async exists() {
        return 0;
      },
      async scan() {
        return [0, []];
      },
    };
    const adapter = upstashAsIdempotencyClient(client);
    const raw = await adapter.get("k");
    expect(raw).toBe(JSON.stringify({ statusCode: 200 }));
  });

  it("scan() translates MATCH/COUNT varargs into upstash options", async () => {
    const client = makeFake();
    const adapter = upstashAsIdempotencyClient(client);
    await adapter.scan?.("0", "MATCH", "idem:*", "COUNT", 50);

    const scanCall = client.calls.find((c) => c[0] === "scan")!;
    expect(scanCall[2]).toEqual({ match: "idem:*", count: 50 });
  });

  it("eval() bridges arc's (numKeys, ...args) to upstash's (keys[], args[])", async () => {
    const evalFn = vi.fn(async () => 1);
    const client: UpstashRedisLike = {
      ...makeFake(),
      eval: evalFn,
    };
    const adapter = upstashAsIdempotencyClient(client);
    // arc calls eval(script, 1, lockKey, requestId)
    await (adapter as { eval: (s: string, n: number, ...a: (string | number)[]) => unknown }).eval(
      "return 1",
      1,
      "lock-key",
      "req-id",
    );

    expect(evalFn).toHaveBeenCalledWith("return 1", ["lock-key"], ["req-id"]);
  });

  it("disconnect() is a no-op for HTTP clients", async () => {
    const client = makeFake();
    const adapter = upstashAsIdempotencyClient(client);
    await expect(adapter.disconnect?.()).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// findByPrefix batching — proves the early-termination contract
// ────────────────────────────────────────────────────────────────────────

describe("RedisIdempotencyStore.findByPrefix batching", () => {
  it("returns the first unexpired match and stops fetching the rest", async () => {
    const now = Date.now();
    const keys = Array.from({ length: 30 }, (_, i) => `idem:POST:/find:${i}`);
    const getSpy = vi.fn(async (key: string) => {
      // Only the 3rd key has an unexpired value; the rest are expired.
      const idx = Number(key.split(":").pop());
      if (idx === 2) {
        return JSON.stringify({
          key: `POST:/find:${idx}`,
          statusCode: 200,
          headers: {},
          body: { found: true },
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
        });
      }
      return JSON.stringify({
        key: `POST:/find:${idx}`,
        statusCode: 200,
        headers: {},
        body: {},
        createdAt: new Date(now - 120_000).toISOString(),
        expiresAt: new Date(now - 60_000).toISOString(), // expired
      });
    });

    let scanned = false;
    const store = new RedisIdempotencyStore({
      client: {
        get: getSpy,
        async set() {
          return "OK";
        },
        async del() {
          return 0;
        },
        async exists() {
          return 0;
        },
        async scan() {
          if (scanned) return ["0", []];
          scanned = true;
          return ["0", keys];
        },
      },
    });

    const result = await store.findByPrefix("POST:/find:");
    expect(result).toBeDefined();
    expect((result?.body as { found: boolean }).found).toBe(true);

    // Batch size is 10 — key index 2 is in the first batch, so we expect
    // exactly 10 GETs (the first batch), not all 30.
    expect(getSpy).toHaveBeenCalledTimes(10);
  });

  it("returns undefined when no keys match", async () => {
    const store = new RedisIdempotencyStore({
      client: {
        async get() {
          return null;
        },
        async set() {
          return "OK";
        },
        async del() {
          return 0;
        },
        async exists() {
          return 0;
        },
        async scan() {
          return ["0", []];
        },
      },
    });

    expect(await store.findByPrefix("POST:/missing:")).toBeUndefined();
  });
});
