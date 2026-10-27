import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HttpCacheOptions, httpCachePlugin } from "../../src/http-cache/index.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close().catch(() => {});
  app = null;
});

async function boot(opts: HttpCacheOptions = {}, extra?: (a: FastifyInstance) => void) {
  const a = Fastify({ logger: false });
  await a.register(httpCachePlugin, opts);
  a.get(
    "/courses",
    { config: { httpCache: { cdn: 600, browser: 60, tags: ["catalog"] } } },
    async () => ({ data: [1] }),
  );
  a.get(
    "/courses/:id",
    {
      config: {
        httpCache: {
          cdn: 300,
          staleIfError: 600,
          tags: (r, body) => [
            `course:${(r.params as { id: string }).id}`,
            ...((body as { tags?: string[] }).tags ?? []),
          ],
        },
      },
    },
    async () => ({ id: "c1", tags: ["catalog"] }),
  );
  a.get("/text", { config: { httpCache: { cdn: 60, tags: ["text"] } } }, async (_r, reply) =>
    reply.type("text/plain").send("hello"),
  );
  a.get("/plain", async () => ({ ok: true }));
  a.get("/missing", { config: { httpCache: { cdn: 60, tags: ["x"] } } }, async (_r, reply) =>
    reply.code(404).send({ e: 1 }),
  );
  a.get("/cookie", { config: { httpCache: { cdn: 60 } } }, async (_r, reply) => {
    reply.header("set-cookie", "sid=1");
    return {};
  });
  a.post("/courses", { config: { httpCache: { cdn: 60 } } }, async () => ({ ok: true }));
  extra?.(a);
  await a.ready();
  app = a;
  return a;
}

describe("httpCachePlugin headers", () => {
  it("answers an anonymous read with Cache-Control, CDN-Cache-Control and tags", async () => {
    const res = await (await boot()).inject({ method: "GET", url: "/courses" });
    expect(res.headers["cache-control"]).toBe("public, max-age=60, s-maxage=600");
    expect(res.headers["cdn-cache-control"]).toBe("max-age=600");
    expect(res.headers["cache-tag"]).toBe("catalog");
  });

  it("computes tags from the request and the body, and carries stale-if-error to both tiers", async () => {
    const res = await (await boot()).inject({ method: "GET", url: "/courses/c1" });
    expect(res.headers["cache-tag"]).toBe("course:c1,catalog");
    expect(res.headers["cache-control"]).toContain("stale-if-error=600");
    expect(res.headers["cdn-cache-control"]).toBe("max-age=300, stale-if-error=600");
  });

  it("treats HEAD like GET (Fastify exposes HEAD routes for GET)", async () => {
    const res = await (await boot()).inject({ method: "HEAD", url: "/courses" });
    expect(res.headers["cache-control"]).toContain("public");
  });

  it("handles non-JSON payloads", async () => {
    const res = await (await boot()).inject({ method: "GET", url: "/text" });
    expect(res.body).toBe("hello");
    expect(res.headers["cache-tag"]).toBe("text");
  });

  it.each([
    [{ authorization: "Bearer t" }],
    [{ "x-organization-id": "o1" }],
    [{ cookie: "session=a" }],
  ])("serves %j private with no tag and no CDN header", async (headers) => {
    const res = await (await boot()).inject({ method: "GET", url: "/courses", headers });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["cdn-cache-control"]).toBeUndefined();
    expect(res.headers["cache-tag"]).toBeUndefined();
  });

  it("never stores a non-2xx or a cookie-setting reply, and leaves writes and undeclared routes alone", async () => {
    const a = await boot();
    expect((await a.inject({ method: "GET", url: "/missing" })).headers["cache-control"]).toBe(
      "no-store",
    );
    expect((await a.inject({ method: "GET", url: "/cookie" })).headers["cache-control"]).toBe(
      "private, no-store",
    );
    expect(
      (await a.inject({ method: "POST", url: "/courses" })).headers["cache-control"],
    ).toBeUndefined();
    expect(
      (await a.inject({ method: "GET", url: "/plain" })).headers["cache-control"],
    ).toBeUndefined();
  });

  it("applies path rules to routes without config; a route's own policy wins", async () => {
    const a = await boot({
      rules: [
        { match: "/plain", cdn: 120, tags: ["plain"] },
        { match: "/courses", cdn: 5 },
      ],
    });
    const plain = await a.inject({ method: "GET", url: "/plain?x=1" });
    expect(plain.headers["cdn-cache-control"]).toBe("max-age=120");
    expect(plain.headers["cache-tag"]).toBe("plain");
    expect((await a.inject({ method: "GET", url: "/courses" })).headers["cdn-cache-control"]).toBe(
      "max-age=600",
    );
  });

  it("fixes CORS on cacheable replies only", async () => {
    const a = await boot({ cors: { origin: "https://shop.example.com" } }, (x) => {
      x.addHook("onRequest", async (_r, reply) => {
        reply.header("access-control-allow-origin", "https://evil.example.com");
        reply.header("access-control-allow-credentials", "true");
      });
    });
    const pub = await a.inject({ method: "GET", url: "/courses" });
    expect(pub.headers["access-control-allow-origin"]).toBe("https://shop.example.com");
    expect(pub.headers["access-control-allow-credentials"]).toBeUndefined();
    const priv = await a.inject({
      method: "GET",
      url: "/courses",
      headers: { authorization: "x" },
    });
    expect(priv.headers["access-control-allow-origin"]).toBe("https://evil.example.com");
  });

  it("uses a configured tag header", async () => {
    const res = await (await boot({ tagHeader: { name: "Surrogate-Key", separator: " " } })).inject(
      { method: "GET", url: "/courses/c1" },
    );
    expect(res.headers["surrogate-key"]).toBe("course:c1 catalog");
  });

  it("redirects a non-canonical query to its canonical URL when asked", async () => {
    const a = await boot({ canonicalQuery: { redirect: true } });
    const res = await a.inject({ method: "GET", url: "/courses?utm_source=x&b=2&a=1" });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe("/courses?a=1&b=2");
    expect((await a.inject({ method: "GET", url: "/courses?a=1&b=2" })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/plain?utm_source=x" })).statusCode).toBe(200);
  });

  it("counts decisions by bounded reason and calls the observer", async () => {
    const onDecision = vi.fn();
    const a = await boot({ observer: { onDecision } });
    await a.inject({ method: "GET", url: "/courses" });
    await a.inject({ method: "GET", url: "/courses", headers: { cookie: "sid=1" } });
    await a.inject({ method: "GET", url: "/missing" });
    const stats = a.httpCache.stats();
    expect(stats.responses.public).toBe(1);
    expect(stats.responses.private).toMatchObject({ cookie: 1, status: 1 });
    expect(onDecision).toHaveBeenCalledWith({
      url: "/courses",
      cacheable: false,
      reason: "cookie:sid",
    });
  });
});

describe("httpCachePlugin configuration is checked at boot", () => {
  it("refuses an invalid route policy when the route registers", async () => {
    const a = Fastify({ logger: false });
    await a.register(httpCachePlugin);
    expect(() => a.get("/bad", { config: { httpCache: { cdn: 0 } } }, async () => ({}))).toThrow(
      "cdn must be a positive",
    );
    await a.close();
  });

  it.each([
    [{ rules: [{ match: "nope", cdn: 10 }] }, "match must start"],
    [{ rules: [{ match: "/x", cdn: -1 }] }, "cdn must be a positive"],
    [{ cors: { origin: "shop.example.com" } }, "cors.origin"],
  ])("refuses %j", async (opts, message) => {
    const a = Fastify({ logger: false });
    await expect(a.register(httpCachePlugin, opts as HttpCacheOptions).ready()).rejects.toThrow(
      message,
    );
    await a.close().catch(() => {});
  });

  it("refuses purgeOn without the events plugin", async () => {
    const a = Fastify({ logger: false });
    await a.register(httpCachePlugin, { purgeOn: { "x.*": () => ["x"] } });
    await expect(a.ready()).rejects.toThrow("events plugin");
    await a.close().catch(() => {});
  });
});
