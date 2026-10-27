/**
 * `httpCachePlugin` beside arc's other caching plugins: it owns `Cache-Control` on the routes that declare a
 * policy, and a reply served from `responseCachePlugin` (a pre-serialized string) carries the same tags.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { httpCachePlugin } from "../../src/http-cache/index.js";
import { cachingPlugin } from "../../src/plugins/caching.js";
import { responseCachePlugin } from "../../src/plugins/response-cache.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close().catch(() => {});
  app = null;
});

const policy = {
  cdn: 600,
  tags: (_r: unknown, body: unknown) => [`org:${(body as { org?: string })?.org}`],
};

describe("httpCachePlugin with cachingPlugin", () => {
  it.each(["caching first", "httpCache first"])(
    "owns Cache-Control on declared routes and leaves the rest to cachingPlugin (%s)",
    async (order) => {
      const a = Fastify({ logger: false });
      const caching = () => a.register(cachingPlugin, { maxAge: 30 });
      const http = () => a.register(httpCachePlugin);
      if (order === "caching first") await caching().then(http);
      else await http().then(caching);
      a.get("/declared", { config: { httpCache: policy } }, async () => ({ org: "o1" }));
      a.get("/plain", async () => ({ ok: true }));
      await a.ready();
      app = a;

      const declared = await a.inject({ method: "GET", url: "/declared" });
      expect(declared.headers["cache-control"]).toBe("public, max-age=0, s-maxage=600");
      expect(declared.headers["cache-tag"]).toBe("org:o1");
      expect(declared.headers.etag).toBeDefined();
      const priv = await a.inject({
        method: "GET",
        url: "/declared",
        headers: { authorization: "Bearer t" },
      });
      expect(priv.headers["cache-control"]).toBe("private, no-store");
      expect((await a.inject({ method: "GET", url: "/plain" })).headers["cache-control"]).toContain(
        "max-age=30",
      );
    },
  );
});

describe("httpCachePlugin with responseCachePlugin", () => {
  it("tags a reply served from the in-process cache exactly like the first one", async () => {
    const a = Fastify({ logger: false });
    await a.register(httpCachePlugin);
    await a.register(responseCachePlugin, { defaultTTL: 60 });
    a.get(
      "/courses/:id",
      { config: { httpCache: policy }, preHandler: [a.responseCache.middleware] },
      async () => ({ org: "o1" }),
    );
    await a.ready();
    app = a;

    const first = await a.inject({ method: "GET", url: "/courses/c1" });
    const hit = await a.inject({ method: "GET", url: "/courses/c1" });
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(first.headers["cache-tag"]).toBe("org:o1");
    expect(hit.headers["cache-tag"]).toBe("org:o1");
    expect(hit.headers["cache-control"]).toBe(first.headers["cache-control"]);
  });
});
