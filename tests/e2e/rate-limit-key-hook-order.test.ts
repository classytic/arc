/**
 * A rate-limit key generator only sees what the lifecycle has already resolved.
 *
 * `@fastify/rate-limit` defaults to `onRequest`, and arc authenticates in a `preHandler`
 * (`registerAuth` / the Better Auth adapter). So a host that supplies a scope-aware
 * `keyGenerator` — the documented way to bucket per tenant or per actor — gets
 * `PUBLIC_SCOPE` at key time and silently falls back to `ctx.ip`.
 *
 * Nothing errors. The limiter works, the host's key function runs, and every bucket is
 * keyed by IP; behind a load balancer with `trustProxy` unset that is ONE address, so a
 * whole deployment shares a single budget while each actor's own sits untouched. It
 * presents as a strict limit rather than as a broken key, which is why this is pinned.
 *
 * These two assertions are the contract a host relies on when it sets `hook: 'preHandler'`.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { RequestScope } from "../../src/scope/types.js";

describe("rate-limit keyGenerator vs scope resolution", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    app = undefined;
  });

  /**
   * Boots a route whose preHandler resolves a member scope — the shape arc's
   * `authenticate` produces — and reports what the key generator observed.
   */
  async function scopeSeenByKeyGenerator(
    hook?: "onRequest" | "preHandler",
  ): Promise<Array<string | undefined>> {
    const { createApp } = await import("../../src/factory/createApp.js");
    const seen: Array<string | undefined> = [];

    app = await createApp({
      logger: false,
      preset: "testing",
      auth: false,
      rateLimit: {
        max: 100,
        timeWindow: "1 minute",
        ...(hook ? { hook } : {}),
        keyGenerator: (request: unknown) => {
          seen.push((request as { scope?: RequestScope }).scope?.kind);
          return "fixed-key";
        },
      },
    });

    app.get(
      "/t",
      {
        preHandler: async (req) => {
          (req as { scope?: RequestScope }).scope = {
            kind: "member",
            userId: "u1",
            organizationId: "o1",
          } as RequestScope;
        },
      },
      async () => ({ ok: true }),
    );

    const res = await app.inject({ method: "GET", url: "/t" });
    expect(res.statusCode).toBe(200);
    return seen;
  }

  it("sees only the PUBLIC scope at the default onRequest hook", async () => {
    expect(await scopeSeenByKeyGenerator()).toEqual(["public"]);
  });

  it("sees the resolved scope at preHandler, which is what makes per-actor keying work", async () => {
    expect(await scopeSeenByKeyGenerator("preHandler")).toEqual(["member"]);
  });
});

/**
 * The ordering above is a trap a host cannot see, so arc does not leave it to them:
 * a generator built by `createTenantKeyGenerator` is TAGGED, and `buildRateLimitOpts`
 * places the hook. The wrong combination is refused rather than warned about, because
 * the symptom in production is "the limit is too strict", never "the key is wrong".
 */
describe("arc places the hook for a scope-aware key generator", () => {
  it("defaults the hook to preHandler", async () => {
    const { buildRateLimitOpts } = await import("../../src/factory/security/rateLimit.js");
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    const opts = buildRateLimitOpts({ max: 10, keyGenerator: createTenantKeyGenerator() });

    expect(opts.hook).toBe("preHandler");
  });

  it("tags a host-supplied strategy too — the wrapper is what carries the marker", async () => {
    const { buildRateLimitOpts } = await import("../../src/factory/security/rateLimit.js");
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    const opts = buildRateLimitOpts({
      max: 10,
      keyGenerator: createTenantKeyGenerator({ strategy: (ctx) => ctx.ip }),
    });

    expect(opts.hook).toBe("preHandler");
  });

  it("REFUSES an explicit onRequest, which cannot do what the caller is asking", async () => {
    const { buildRateLimitOpts } = await import("../../src/factory/security/rateLimit.js");
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    expect(() =>
      buildRateLimitOpts({
        max: 10,
        hook: "onRequest",
        keyGenerator: createTenantKeyGenerator(),
      }),
    ).toThrow(/scope-aware keyGenerator/i);
  });

  it("leaves a plain keyGenerator alone — no scope, no opinion", async () => {
    const { buildRateLimitOpts } = await import("../../src/factory/security/rateLimit.js");

    const opts = buildRateLimitOpts({ max: 10, keyGenerator: (req: { ip: string }) => req.ip });

    expect(opts.hook).toBeUndefined();
  });

  it("still keys per actor once the hook is placed", async () => {
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");
    const keyGen = createTenantKeyGenerator();

    const memberKey = keyGen({
      ip: "10.0.1.4",
      scope: { kind: "member", organizationId: "org-1", userId: "u1" } as RequestScope,
    });
    const publicKey = keyGen({ ip: "10.0.1.4" });

    // The whole point: two callers behind ONE proxy address must not share a bucket.
    expect(memberKey).toBe("org-1");
    expect(publicKey).toBe("10.0.1.4");
    expect(memberKey).not.toBe(publicKey);
  });
});
