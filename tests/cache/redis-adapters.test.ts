/**
 * Unit tests for the ioredis / @upstash/redis adapter helpers.
 *
 * These prove the option-shape translation without hitting real Redis —
 * important because the previous DX gap was "users keep reinventing the
 * adapter". Pinning the contract here catches any future drift in the
 * arc `RedisCacheClient` interface.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type IoredisLike,
  ioredisAsCacheClient,
  type UpstashRedisLike,
  upstashAsCacheClient,
} from "../../src/cache/redis.js";

// ────────────────────────────────────────────────────────────────────────
// ioredis adapter
// ────────────────────────────────────────────────────────────────────────

describe("ioredisAsCacheClient", () => {
  function makeFakeIoredis(): IoredisLike & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      async get(key) {
        calls.push(["get", key]);
        return "cached-value";
      },
      async set(...args) {
        calls.push(["set", ...args]);
        return "OK";
      },
      async del(...keys) {
        calls.push(["del", ...keys]);
        return keys.length;
      },
      async scan(cursor, ...args) {
        calls.push(["scan", cursor, ...args]);
        return ["0", ["key-1", "key-2"]];
      },
    };
  }

  it("set() with PX — positional flags", async () => {
    const client = makeFakeIoredis();
    const adapter = ioredisAsCacheClient(client);
    await adapter.set("k", "v", { PX: 5_000 });

    const setCall = client.calls.find((c) => c[0] === "set");
    expect(setCall).toEqual(["set", "k", "v", "PX", 5_000]);
  });

  it("set() with EX — positional flags", async () => {
    const client = makeFakeIoredis();
    const adapter = ioredisAsCacheClient(client);
    await adapter.set("k", "v", { EX: 30 });

    const setCall = client.calls.find((c) => c[0] === "set");
    expect(setCall).toEqual(["set", "k", "v", "EX", 30]);
  });

  it("set() with NX + PX — positional flags in order", async () => {
    const client = makeFakeIoredis();
    const adapter = ioredisAsCacheClient(client);
    await adapter.set("k", "v", { PX: 1_000, NX: true });

    const setCall = client.calls.find((c) => c[0] === "set");
    expect(setCall).toEqual(["set", "k", "v", "PX", 1_000, "NX"]);
  });

  it("set() without options — plain set", async () => {
    const client = makeFakeIoredis();
    const adapter = ioredisAsCacheClient(client);
    await adapter.set("k", "v");

    const setCall = client.calls.find((c) => c[0] === "set");
    expect(setCall).toEqual(["set", "k", "v"]);
  });

  it("del() with a single key — forwards a single arg", async () => {
    const client = makeFakeIoredis();
    const adapter = ioredisAsCacheClient(client);
    await adapter.del("k");

    const delCall = client.calls.find((c) => c[0] === "del");
    expect(delCall).toEqual(["del", "k"]);
  });

  it("del() with an array — spreads into varargs", async () => {
    const client = makeFakeIoredis();
    const adapter = ioredisAsCacheClient(client);
    await adapter.del(["k1", "k2", "k3"]);

    const delCall = client.calls.find((c) => c[0] === "del");
    expect(delCall).toEqual(["del", "k1", "k2", "k3"]);
  });

  it("scan() passes through cursor and varargs", async () => {
    const client = makeFakeIoredis();
    const adapter = ioredisAsCacheClient(client);
    const [next, keys] = await adapter.scan!("0", "MATCH", "arc:cache:*", "COUNT", 100);

    const scanCall = client.calls.find((c) => c[0] === "scan");
    expect(scanCall).toEqual(["scan", "0", "MATCH", "arc:cache:*", "COUNT", 100]);
    expect(next).toBe("0");
    expect(keys).toEqual(["key-1", "key-2"]);
  });

  it("exposes pipeline when the underlying client supports it", () => {
    const pipelineFn = vi.fn();
    const client: IoredisLike = {
      ...makeFakeIoredis(),
      pipeline: pipelineFn,
    };
    const adapter = ioredisAsCacheClient(client);
    expect(adapter.pipeline).toBeDefined();
  });

  it("omits pipeline when the underlying client doesn't support it", () => {
    const client = makeFakeIoredis(); // no pipeline
    const adapter = ioredisAsCacheClient(client);
    expect(adapter.pipeline).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// @upstash/redis (REST SDK) adapter
// ────────────────────────────────────────────────────────────────────────

describe("upstashAsCacheClient", () => {
  function makeFakeUpstash(): UpstashRedisLike & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      async get(key) {
        calls.push(["get", key]);
        return "cached-value";
      },
      async set(key, value, opts) {
        calls.push(["set", key, value, opts]);
        return "OK";
      },
      async del(...keys) {
        calls.push(["del", ...keys]);
        return keys.length;
      },
      async scan(cursor, opts) {
        calls.push(["scan", cursor, opts]);
        return [0, ["arc:cache:a", "arc:cache:b"]];
      },
    };
  }

  it("set() with PX → lowercase 'px' option for upstash", async () => {
    const client = makeFakeUpstash();
    const adapter = upstashAsCacheClient(client);
    await adapter.set("k", "v", { PX: 5_000 });

    const setCall = client.calls.find((c) => c[0] === "set")!;
    expect(setCall[3]).toEqual({ px: 5_000 });
  });

  it("set() with EX + NX → lowercase 'ex' + 'nx' options", async () => {
    const client = makeFakeUpstash();
    const adapter = upstashAsCacheClient(client);
    await adapter.set("k", "v", { EX: 60, NX: true });

    const setCall = client.calls.find((c) => c[0] === "set")!;
    expect(setCall[3]).toEqual({ ex: 60, nx: true });
  });

  it("get() re-serializes non-string values for arc contract compatibility", async () => {
    // Upstash auto-deserializes, so a JSON object may come back as an object.
    // Arc's RedisCacheStore expects a JSON string it can JSON.parse — this
    // adapter must re-stringify objects so the round-trip is lossless.
    const client: UpstashRedisLike = {
      async get() {
        return { foo: "bar" } as unknown; // upstash auto-parsed
      },
      async set() {
        return "OK";
      },
      async del() {
        return 0;
      },
      async scan() {
        return [0, []];
      },
    };
    const adapter = upstashAsCacheClient(client);
    const raw = await adapter.get("k");
    expect(raw).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("get() passes strings through unchanged", async () => {
    const client: UpstashRedisLike = {
      async get() {
        return '{"already":"json"}';
      },
      async set() {
        return "OK";
      },
      async del() {
        return 0;
      },
      async scan() {
        return [0, []];
      },
    };
    const adapter = upstashAsCacheClient(client);
    const raw = await adapter.get("k");
    expect(raw).toBe('{"already":"json"}');
  });

  it("get() returns null for missing keys", async () => {
    const client: UpstashRedisLike = {
      async get() {
        return null;
      },
      async set() {
        return "OK";
      },
      async del() {
        return 0;
      },
      async scan() {
        return [0, []];
      },
    };
    const adapter = upstashAsCacheClient(client);
    expect(await adapter.get("missing")).toBe(null);
  });

  it("scan() translates varargs MATCH/COUNT into upstash's options object", async () => {
    const client = makeFakeUpstash();
    const adapter = upstashAsCacheClient(client);
    const [next, keys] = await adapter.scan!("0", "MATCH", "arc:cache:*", "COUNT", 100);

    const scanCall = client.calls.find((c) => c[0] === "scan")!;
    expect(scanCall[2]).toEqual({ match: "arc:cache:*", count: 100 });
    expect(String(next)).toBe("0");
    expect(keys).toEqual(["arc:cache:a", "arc:cache:b"]);
  });

  it("del() with array spreads into upstash varargs", async () => {
    const client = makeFakeUpstash();
    const adapter = upstashAsCacheClient(client);
    await adapter.del(["k1", "k2"]);

    const delCall = client.calls.find((c) => c[0] === "del")!;
    expect(delCall).toEqual(["del", "k1", "k2"]);
  });
});
