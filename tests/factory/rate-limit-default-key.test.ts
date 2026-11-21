/**
 * Arc's default rate-limit key: per signed-in user, per IP when anonymous.
 *
 * One office Wi-Fi or carrier NAT must never throttle many signed-in users together, while
 * sign-in / sign-up / reset (no user yet) stay limited per IP. A high per-IP ceiling at
 * `onRequest` keeps a cheap flood guard. Hosts that pick a `keyGenerator` or `plan` keep
 * exactly what they had.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildRateLimitOpts, resolveIpCeiling } from "../../src/factory/security/rateLimit.js";
import { createTenantKeyGenerator, ipBucket } from "../../src/scope/rateLimitKey.js";
import type { RequestScope } from "../../src/scope/types.js";

const OFFICE_IP = "203.0.113.7";

describe("default rate-limit key (createApp)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    app = undefined;
  });

  /** A route whose preHandler resolves a member scope from `x-user`, as `authenticate` would. */
  async function boot(rateLimit: Record<string, unknown>): Promise<FastifyInstance> {
    const { createApp } = await import("../../src/factory/createApp.js");
    app = await createApp({ logger: false, preset: "testing", auth: false, rateLimit });
    const resolveScope = async (req: { headers: Record<string, unknown>; scope?: unknown }) => {
      const user = req.headers["x-user"];
      if (typeof user === "string") {
        req.scope = { kind: "member", userId: user, organizationId: "org-1" } as RequestScope;
      }
    };
    app.get("/t", { preHandler: resolveScope }, async () => ({ ok: true }));
    app.get("/open", { config: { rateLimit: false } }, async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  const hit = (a: FastifyInstance, user?: string, ip = OFFICE_IP, url = "/t") =>
    a.inject({ method: "GET", url, remoteAddress: ip, headers: user ? { "x-user": user } : {} });

  it("two signed-in users behind one IP do not share a bucket", async () => {
    const a = await boot({ max: 2, timeWindow: "1 minute" });
    for (let i = 0; i < 2; i++) expect((await hit(a, "alice")).statusCode).toBe(200);
    expect((await hit(a, "alice")).statusCode).toBe(429);
    // Same office IP, same organisation — bob's budget is untouched.
    expect((await hit(a, "bob")).statusCode).toBe(200);
    expect((await hit(a, "bob")).statusCode).toBe(200);
  });

  it("anonymous requests are keyed by IP", async () => {
    const a = await boot({ max: 2, timeWindow: "1 minute" });
    expect((await hit(a)).statusCode).toBe(200);
    expect((await hit(a)).statusCode).toBe(200);
    expect((await hit(a)).statusCode).toBe(429);
    expect((await hit(a, undefined, "198.51.100.9")).statusCode).toBe(200);
  });

  it("an allowList of addresses still exempts signed-in callers from that address", async () => {
    const a = await boot({ max: 1, timeWindow: "1 minute", allowList: [OFFICE_IP] });
    for (let i = 0; i < 3; i++) expect((await hit(a, "alice")).statusCode).toBe(200);
  });

  it("the early per-IP ceiling bounds one address across many users", async () => {
    const a = await boot({ max: 100, timeWindow: "1 minute", ipCeiling: 3 });
    expect((await hit(a, "u1")).statusCode).toBe(200);
    expect((await hit(a, "u2")).statusCode).toBe(200);
    expect((await hit(a, "u3")).statusCode).toBe(200);
    const res = await hit(a, "u4");
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    // Another address has its own ceiling; a route that opted out is never counted.
    expect((await hit(a, "u4", "198.51.100.9")).statusCode).toBe(200);
    expect((await hit(a, undefined, OFFICE_IP, "/open")).statusCode).toBe(200);
  });

  it("an explicit host keyGenerator is untouched: its own hook, no ceiling", async () => {
    const seen: Array<string | undefined> = [];
    const a = await boot({
      max: 2,
      timeWindow: "1 minute",
      keyGenerator: (req: { scope?: RequestScope }) => {
        seen.push(req.scope?.kind);
        return "shared";
      },
    });
    expect((await hit(a, "alice")).statusCode).toBe(200);
    expect((await hit(a, "bob")).statusCode).toBe(200);
    expect((await hit(a, "carol")).statusCode).toBe(429);
    expect(seen.every((kind) => kind === "public")).toBe(true);
  });
});

describe("buildRateLimitOpts / resolveIpCeiling", () => {
  it("installs the per-user key at preHandler when the host chose nothing", () => {
    const opts = buildRateLimitOpts({ max: 10 });
    expect(typeof opts.keyGenerator).toBe("function");
    expect(opts.hook).toBe("preHandler");
    expect(opts).not.toHaveProperty("ipCeiling");
  });

  it("leaves a host keyGenerator, plan, or explicit onRequest hook alone", () => {
    const keyGenerator = () => "k";
    expect(buildRateLimitOpts({ max: 10, keyGenerator }).keyGenerator).toBe(keyGenerator);
    expect(buildRateLimitOpts({ max: 10, keyGenerator }).hook).toBeUndefined();
    const onRequest = buildRateLimitOpts({ max: 10, hook: "onRequest" });
    expect(onRequest.keyGenerator).toBeUndefined();
    expect(onRequest.hook).toBe("onRequest");
    const plan = { resolve: () => "free", limits: { free: { max: 1 } } };
    expect(resolveIpCeiling({ max: 10, plan })).toBeUndefined();
    expect(resolveIpCeiling({ max: 10, keyGenerator })).toBeUndefined();
    expect(resolveIpCeiling({ max: 10, hook: "onRequest" })).toBeUndefined();
  });

  it("defaults the ceiling to max(2000, 20 × max) per window", () => {
    expect(resolveIpCeiling({ max: 100, timeWindow: "1 minute" })).toEqual({
      max: 2000,
      timeWindow: "1 minute",
    });
    expect(resolveIpCeiling({ max: 500, timeWindow: 1000 })).toEqual({
      max: 10000,
      timeWindow: 1000,
    });
    expect(resolveIpCeiling({ max: 100, ipCeiling: false })).toBeUndefined();
    expect(resolveIpCeiling({ max: 100, ipCeiling: 50 })?.max).toBe(50);
    expect(() => resolveIpCeiling({ ipCeiling: 0 })).toThrow(/ipCeiling/);
  });
});

describe("createTenantKeyGenerator strategies", () => {
  const member = { kind: "member", userId: "u1", organizationId: "org-1" } as RequestScope;

  it("'user' keys by user when signed in, by IP when anonymous", () => {
    const gen = createTenantKeyGenerator({ strategy: "user" });
    expect(gen({ ip: "1.2.3.4", scope: member })).toBe("user:u1");
    expect(gen({ ip: "1.2.3.4", scope: { kind: "public" } as RequestScope })).toBe("1.2.3.4");
    expect(gen({ ip: "1.2.3.4" })).toBe("1.2.3.4");
  });

  it("'organization' is the unchanged default", () => {
    const named = createTenantKeyGenerator({ strategy: "organization" });
    const omitted = createTenantKeyGenerator();
    expect(named({ ip: "1.2.3.4", scope: member })).toBe("org-1");
    expect(omitted({ ip: "1.2.3.4", scope: member })).toBe("org-1");
  });

  it("groups IPv6 by /64 and unwraps IPv4-mapped addresses", () => {
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe(ipBucket("2001:db8:1:2:bbbb::9"));
    expect(ipBucket("2001:db8:1:2::1")).not.toBe(ipBucket("2001:db8:1:3::1"));
    expect(ipBucket("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(ipBucket("10.0.0.1")).toBe("10.0.0.1");
  });
});
