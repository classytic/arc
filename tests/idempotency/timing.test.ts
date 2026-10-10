import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import idempotencyPlugin from "../../src/idempotency/idempotencyPlugin.js";

describe("idempotency timing configuration", () => {
  it.each([
    { ttlMs: 0 },
    { ttlMs: Number.POSITIVE_INFINITY },
    { lockTimeoutMs: -1 },
    { lockTimeoutMs: Number.NaN },
  ])("rejects invalid durations %o at registration", async (timing) => {
    const app = Fastify();
    app.register(idempotencyPlugin, { enabled: true, selfCheck: false, ...timing });
    await expect(app.ready()).rejects.toThrow(/positive finite/);
    await app.close();
  });
  it("exposes configured transport-neutral timings on its decorator", async () => {
    const app = Fastify();
    app.register(idempotencyPlugin, {
      enabled: true,
      selfCheck: false,
      ttlMs: 120_000,
      lockTimeoutMs: 75_000,
    });
    await app.ready();
    expect(app.idempotency).toMatchObject({ ttlMs: 120_000, lockTimeoutMs: 75_000 });
    await app.close();
  });
});
