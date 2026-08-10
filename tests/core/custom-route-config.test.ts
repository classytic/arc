/**
 * A route's `config` reaches Fastify.
 *
 * Fastify's own per-route option (Reference/Routes.md § Config) — it is how every
 * Fastify plugin takes per-route settings, and it is readable at request time as
 * `request.routeOptions.config`.
 *
 * ## Why this is worth a test rather than a one-line passthrough
 *
 * Arc REGISTERS `fastify-raw-body` with `global: false`, which means a route opts in
 * with `config: { rawBody: true }`. `RouteDefinition` had no `config` field, so that
 * opt-in had nowhere to live: the plugin arc itself installs was unreachable from any
 * resource, and a route that declared it got no error — just a silently absent
 * `request.rawBody`.
 *
 * The cost showed up end to end, not in review. Every HMAC-signed webhook verified
 * its signature against a body it never received, so a real provider callback 401'd
 * in production while every unit test passed. A passthrough this thin is exactly the
 * kind that gets dropped in a refactor and reported by nothing.
 */
import { describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

/** Boot arc with one resource, plus any plugin the case needs registered first. */
async function bootWith(
  resource: ReturnType<typeof defineResource>,
  before?: (f: { register: (p: unknown, o?: unknown) => Promise<unknown> }) => Promise<void>,
) {
  const app = await createApp({
    preset: "testing",
    auth: false,
    logger: false,
    plugins: async (f) => {
      // BEFORE the resource: `fastify-raw-body` runs as an onRequest hook and must be
      // registered on the instance the routes land on.
      if (before) await before(f as never);
      await f.register(resource.toPlugin());
    },
  });
  await app.ready();
  return app;
}

describe("custom route config", () => {
  it("forwards `config` to the Fastify route, readable at request time", async () => {
    const resource = defineResource({
      name: "widget",
      prefix: "/widgets",
      disableDefaultRoutes: true,
      tenantField: false,
      routes: [
        {
          method: "GET" as const,
          path: "/echo",
          permissions: allowPublic(),
          config: { output: "hello world!" },
          rawHandler: async (req: { routeOptions?: { config?: { output?: string } } }) => ({
            output: req.routeOptions?.config?.output ?? null,
          }),
        },
      ],
    });

    const app = await bootWith(resource);
    const res = await app.inject({ method: "GET", url: "/widgets/echo" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ output: "hello world!" });
    await app.close();
  });

  it("OPTS IN to a plugin that reads config per-route — the raw-body case", async () => {
    /**
     * The concrete reason this field exists, against the plugin ARC ITSELF registers.
     *
     * `registerSecurity` already installs `fastify-raw-body` with `global: false`, so
     * the plugin was present all along — the only missing piece was a route's ability
     * to opt in. Registering it again here throws "Cannot register fastify-raw-body
     * twice", which is itself the proof that forwarding `config` is the whole fix.
     *
     * A genuine round trip, not an assertion about the object: `global: false` means
     * `request.rawBody` is populated ONLY for routes whose config says so.
     */
    const resource = defineResource({
      name: "hook",
      prefix: "/hooks",
      disableDefaultRoutes: true,
      tenantField: false,
      routes: [
        {
          method: "POST" as const,
          path: "/in",
          permissions: allowPublic(),
          config: { rawBody: true },
          rawHandler: async (req: { rawBody?: string | Buffer }) => ({
            raw:
              typeof req.rawBody === "string"
                ? req.rawBody
                : (req.rawBody?.toString("utf8") ?? null),
          }),
        },
      ],
    });

    const app = await bootWith(resource);

    // Deliberately irregular spacing: the point is that the EXACT bytes survive.
    // `JSON.stringify(request.body)` would normalise them and break every HMAC.
    const body = '{"a":  1,"b":"x"}';
    const res = await app.inject({
      method: "POST",
      url: "/hooks/in",
      headers: { "content-type": "application/json" },
      payload: body,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().raw).toBe(body);
    await app.close();
  });

  it("injects NOTHING of its own into config", async () => {
    /**
     * Fastify ALWAYS seeds `route.config` with `{ url, method }`, so "no config key"
     * is not a state that exists — an earlier version of this docblock claimed the
     * conditional spread prevented one, and falsification showed always-spreading an
     * empty object passes identically. The conditional is style, not behaviour.
     *
     * What IS worth guarding is that arc adds no keys of its own: a framework quietly
     * seeding config would collide with whatever a plugin expects to read there, and
     * the collision would surface as that plugin misbehaving rather than as an error
     * here.
     */
    const seen: Array<Record<string, unknown>> = [];

    const resource = defineResource({
      name: "plain",
      prefix: "/plain",
      disableDefaultRoutes: true,
      tenantField: false,
      routes: [
        {
          method: "GET" as const,
          path: "/x",
          permissions: allowPublic(),
          rawHandler: async () => ({ ok: true }),
        },
      ],
    });

    const app = await createApp({
      preset: "testing",
      auth: false,
      logger: false,
      plugins: async (f) => {
        f.addHook("onRoute", (route) => {
          if (String(route.url).startsWith("/plain"))
            seen.push((route.config ?? {}) as Record<string, unknown>);
        });
        await f.register(resource.toPlugin());
      },
    });
    await app.ready();

    expect(seen.length).toBeGreaterThan(0);
    // Fastify seeds `config` with `{ url, method }`; the assertion is that arc added
    // nothing of its own on top.
    for (const config of seen) {
      expect(Object.keys(config).filter((k) => k !== "url" && k !== "method")).toEqual([]);
    }
    await app.close();
  });
});

/**
 * `config` must SURVIVE arc's own route config.
 *
 * Fastify builds a route's context from a SINGLE `opts.config`
 * (`{ ...opts.config, url, method }` — lib/route.js), so it does not merge two
 * sources: whichever spread arc emits last replaces the other outright. Arc emits
 * its own `config` for per-route rate limit, cors and `arcExtensions`, so a route
 * declaring `config` lost it entirely on any resource with one of those.
 *
 * That is the SAME silent-absence bug `config` exists to fix — a webhook keeps
 * verifying its HMAC against a body it never received — narrowed to exactly the
 * resources most likely to be production ones.
 */
describe("custom route config — merged with arc's own", () => {
  const echoConfig = async (
    req: { routeOptions: { config?: Record<string, unknown> } },
    reply: { send: (v: unknown) => unknown },
  ) => reply.send({ cfg: req.routeOptions.config ?? {} });

  it("survives when the resource also declares `extensions`", async () => {
    const app = await bootWith(
      defineResource({
        name: "hookext",
        disableDefaultRoutes: true,
        extensions: { encryption: { fields: ["secret"] } } as never,
        routes: [
          {
            method: "POST",
            path: "/webhooks",
            permissions: allowPublic(),
            config: { rawBody: true },
            rawHandler: echoConfig as never,
          },
        ],
      }),
    );

    const res = await app.inject({ method: "POST", url: "/hookexts/webhooks", payload: {} });
    const cfg = JSON.parse(res.body).cfg;
    expect(cfg.rawBody).toBe(true); // the host's key
    expect(cfg.arcExtensions).toBeDefined(); // and arc's, side by side
    await app.close();
  });

  it("survives alongside a per-route rateLimit, and arc's key wins a collision", async () => {
    const app = await bootWith(
      defineResource({
        name: "hookrl",
        disableDefaultRoutes: true,
        routes: [
          {
            method: "POST",
            path: "/webhooks",
            permissions: allowPublic(),
            rateLimit: { max: 5, timeWindow: "1 minute" },
            // `rateLimit` written by hand too — arc's derived value must win, so one
            // setting never has two sources that can disagree.
            config: { rawBody: true, rateLimit: { max: 9999 } },
            rawHandler: echoConfig as never,
          },
        ],
      }),
    );

    const res = await app.inject({ method: "POST", url: "/hookrls/webhooks", payload: {} });
    const cfg = JSON.parse(res.body).cfg;
    expect(cfg.rawBody).toBe(true);
    expect(cfg.rateLimit.max).toBe(5);
    await app.close();
  });
});
