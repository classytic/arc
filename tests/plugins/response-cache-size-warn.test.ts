/**
 * Wave-12 performance: responseCachePlugin warns at registration when
 * `maxEntries` is sized beyond what its synchronous prefix-invalidation
 * scan can handle without event-loop pauses (> 5000). The plugin is an
 * instance-local micro-cache; large shared caching belongs in queryCache
 * with a Redis store.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { responseCachePlugin } from "../../src/plugins/response-cache.js";

describe("responseCachePlugin — oversized maxEntries warning", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it("warns when maxEntries exceeds 5000", async () => {
    app = Fastify({ logger: false });
    const warn = vi.spyOn(app.log, "warn");
    await app.register(responseCachePlugin, { maxEntries: 10_000 });
    await app.ready();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("prefix invalidation"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("maxEntries=10000"));
  });

  it("stays silent at the default and at moderate sizes", async () => {
    app = Fastify({ logger: false });
    const warn = vi.spyOn(app.log, "warn");
    await app.register(responseCachePlugin, { maxEntries: 5000 });
    await app.ready();

    const calls = warn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("prefix invalidation"))).toBe(false);
  });
});
