/**
 * A route's `config.rateLimit` moves onto arc's resource limiter. The host's `keyGenerator`,
 * `groupId` and `allowList` ride with it (they were dropped: every route was keyed per IP, so
 * many devices behind one NAT address shared one budget). An option arc cannot honour refuses
 * to register instead of disappearing.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

const deviceKey = (req: FastifyRequest): string => `device:${String(req.headers["x-device"])}`;

function resource(name: string, rateLimit: Record<string, unknown>, paths = ["/hit"]) {
  return defineResource({
    name,
    prefix: `/${name}`,
    disableDefaultRoutes: true,
    routes: paths.map((path) => ({
      method: "POST" as const,
      path,
      permissions: allowPublic(),
      config: { rateLimit },
      handler: async () => ({ data: { ok: true } }),
    })),
  });
}

async function boot(...resources: ReturnType<typeof resource>[]) {
  return createApp({
    preset: "testing",
    auth: false,
    logger: false,
    rateLimit: { max: 1000, timeWindow: "1 minute" },
    resources,
  });
}

const hit = (app: FastifyInstance, url: string, device?: string) =>
  app.inject({
    method: "POST",
    url,
    payload: {},
    remoteAddress: "10.0.0.7",
    ...(device ? { headers: { "x-device": device } } : {}),
  });

describe("route config.rateLimit host options on arc's resource limiter", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close().catch(() => {});
    app = undefined;
  });

  it("keyGenerator: two keys from one IP get separate budgets", async () => {
    app = await boot(
      resource("field", { max: 1, timeWindow: "1 minute", keyGenerator: deviceKey }),
    );
    expect((await hit(app, "/field/hit", "a")).statusCode).toBe(200);
    const blocked = await hit(app, "/field/hit", "a");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({
      code: "arc.rate_limited",
      message: "Too many calls to this resource — retry later.",
      status: 429,
    });
    expect(blocked.headers["retry-after"]).toBeDefined();
    const other = await hit(app, "/field/hit", "b");
    expect(other.statusCode).toBe(200);
    expect(other.headers["x-ratelimit-limit"]).toBe("1");
    expect(other.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("keyGenerator may be async", async () => {
    app = await boot(
      resource("async", {
        max: 1,
        timeWindow: "1 minute",
        keyGenerator: async (req: FastifyRequest) => deviceKey(req),
      }),
    );
    expect((await hit(app, "/async/hit", "a")).statusCode).toBe(200);
    expect((await hit(app, "/async/hit", "b")).statusCode).toBe(200);
    expect((await hit(app, "/async/hit", "a")).statusCode).toBe(429);
  });

  it("allowList (keys) bypasses the limit; other keys are still limited", async () => {
    app = await boot(
      resource("vip", {
        max: 1,
        timeWindow: "1 minute",
        keyGenerator: deviceKey,
        allowList: ["device:root"],
      }),
    );
    for (let i = 0; i < 3; i++) expect((await hit(app, "/vip/hit", "root")).statusCode).toBe(200);
    expect((await hit(app, "/vip/hit", "x")).statusCode).toBe(200);
    expect((await hit(app, "/vip/hit", "x")).statusCode).toBe(429);
  });

  it("allowList (function) receives the request and key", async () => {
    const seen: string[] = [];
    app = await boot(
      resource("probe", {
        max: 1,
        timeWindow: "1 minute",
        allowList: (_req: FastifyRequest, key: string) => {
          seen.push(key);
          return key === "10.0.0.7";
        },
      }),
    );
    for (let i = 0; i < 3; i++) expect((await hit(app, "/probe/hit")).statusCode).toBe(200);
    expect(seen).toEqual(["10.0.0.7", "10.0.0.7", "10.0.0.7"]);
  });

  it("groupId shares one budget across routes of different resources", async () => {
    const policy = { max: 1, timeWindow: "1 minute", groupId: "auth" };
    app = await boot(resource("left", policy), resource("right", policy));
    expect((await hit(app, "/left/hit")).statusCode).toBe(200);
    expect((await hit(app, "/right/hit")).statusCode).toBe(429);
  });

  it("routes without these options behave as before: per IP, per resource", async () => {
    const policy = { max: 1, timeWindow: "1 minute" };
    app = await boot(resource("plain", policy), resource("other", policy));
    const first = await hit(app, "/plain/hit", "a");
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-limit"]).toBe("1");
    expect(first.headers["x-ratelimit-remaining"]).toBe("0");
    expect(first.headers["x-ratelimit-reset"]).toBeDefined();
    // A different device header from the same IP shares the budget: the IP is the key.
    const blocked = await hit(app, "/plain/hit", "b");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe("arc.rate_limited");
    // Another resource keeps its own budget.
    expect((await hit(app, "/other/hit")).statusCode).toBe(200);
  });

  it("refuses to register an option it cannot honour", async () => {
    await expect(
      boot(resource("hooked", { max: 1, timeWindow: "1 minute", hook: "onRequest" })),
    ).rejects.toThrow(/config\.rateLimit\.hook is not supported/);
  });

  it("refuses a malformed keyGenerator, groupId or allowList", async () => {
    await expect(
      boot(resource("bad1", { max: 1, timeWindow: "1 minute", keyGenerator: "ip" })),
    ).rejects.toThrow(/keyGenerator must be a function/);
    await expect(
      boot(resource("bad2", { max: 1, timeWindow: "1 minute", groupId: "" })),
    ).rejects.toThrow(/groupId must be a non-empty string/);
    await expect(
      boot(resource("bad3", { max: 1, timeWindow: "1 minute", allowList: "10.0.0.7" })),
    ).rejects.toThrow(/allowList must be an array of keys or a function/);
  });

  it("refuses one groupId declared with two different limits", async () => {
    await expect(
      boot(
        resource("g1", { max: 1, timeWindow: "1 minute", groupId: "shared" }),
        resource("g2", { max: 2, timeWindow: "1 minute", groupId: "shared" }),
      ),
    ).rejects.toThrow(/groupId "shared" is declared with two different limits/);
  });
});
