/**
 * Smart CORS (2.22) — arc protocol headers auto-merge into host
 * `allowedHeaders` allow-lists.
 *
 * The trap (found live in a Capacitor host): a host declaring
 * `allowedHeaders: ['Content-Type', 'Authorization']` silently breaks
 * tenancy/elevation for webview + SPA clients — the preflight rejects
 * `x-organization-id` / `x-arc-scope` and requests arrive scope-less.
 * Arc knows its own header names; hosts must never have to recite them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/factory/createApp.js";

const apps: Array<{ close(): Promise<void> }> = [];

async function buildApp(cors: Record<string, unknown>) {
  const app = await createApp({ preset: "testing", auth: false, cors });
  await app.ready();
  apps.push(app);
  return app;
}

async function preflight(app: Awaited<ReturnType<typeof buildApp>>, requestHeaders: string) {
  return app.inject({
    method: "OPTIONS",
    url: "/anything",
    headers: {
      origin: "capacitor://localhost",
      "access-control-request-method": "POST",
      "access-control-request-headers": requestHeaders,
    },
  });
}

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

describe("Smart CORS — arc protocol headers", () => {
  it("merges arc headers into a host allow-list (the Capacitor trap)", async () => {
    const app = await buildApp({
      origin: ["capacitor://localhost"],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"], // host forgot arc's
    });

    const res = await preflight(app, "content-type,authorization,x-organization-id,x-arc-scope");
    expect(res.statusCode).toBeLessThan(300);
    const allowed = String(res.headers["access-control-allow-headers"]).toLowerCase();
    expect(allowed).toContain("content-type");
    expect(allowed).toContain("authorization");
    expect(allowed).toContain("x-organization-id");
    expect(allowed).toContain("x-arc-scope");
    expect(allowed).toContain("x-request-id");
  });

  it("does not duplicate headers the host already declared (case-insensitive)", async () => {
    const app = await buildApp({
      origin: true,
      allowedHeaders: ["Content-Type", "X-Organization-Id"],
    });

    const res = await preflight(app, "content-type,x-organization-id");
    const allowed = String(res.headers["access-control-allow-headers"]).toLowerCase();
    expect(allowed.match(/x-organization-id/g)).toHaveLength(1);
  });

  it("stays a no-op when allowedHeaders is unset (reflection mode)", async () => {
    const app = await buildApp({ origin: true });
    const res = await preflight(app, "x-organization-id,x-custom-anything");
    // @fastify/cors reflects the requested headers — no allow-list, no trap.
    const allowed = String(res.headers["access-control-allow-headers"]).toLowerCase();
    expect(allowed).toContain("x-custom-anything");
  });
});

describe("Smart CORS — arc exposed headers (set-auth-token)", () => {
  // The trap (found live in a Capacitor host): the bearer plugin returns the
  // session token in the `set-auth-token` RESPONSE header. Unset
  // `exposedHeaders` exposes NOTHING beyond the CORS safelist, so cross-origin
  // JS completed the login POST but could never read the token — bearer auth
  // silently died. Arc always exposes its own auth protocol header.

  it("creates exposedHeaders with set-auth-token when the host declared none", async () => {
    const app = await buildApp({ origin: ["capacitor://localhost"], credentials: true });

    const res = await app.inject({
      method: "GET",
      url: "/anything",
      headers: { origin: "capacitor://localhost" },
    });
    const exposed = String(res.headers["access-control-expose-headers"]).toLowerCase();
    expect(exposed).toContain("set-auth-token");
  });

  it("merges set-auth-token into a host-declared exposedHeaders list without dropping entries", async () => {
    const app = await buildApp({
      origin: true,
      exposedHeaders: ["x-total-count"],
    });

    const res = await app.inject({
      method: "GET",
      url: "/anything",
      headers: { origin: "http://spa.test" },
    });
    const exposed = String(res.headers["access-control-expose-headers"]).toLowerCase();
    expect(exposed).toContain("x-total-count");
    expect(exposed).toContain("set-auth-token");
  });

  it("does NOT mutate the host's exposedHeaders array (config object stays caller-owned)", async () => {
    const hostExposed = ["x-total-count"];
    const app = await buildApp({ origin: true, exposedHeaders: hostExposed });

    const res = await app.inject({
      method: "GET",
      url: "/anything",
      headers: { origin: "http://spa.test" },
    });
    // The response carries the merged list…
    expect(String(res.headers["access-control-expose-headers"]).toLowerCase()).toContain(
      "set-auth-token",
    );
    // …but the HOST's array is untouched (no push into the caller's config).
    expect(hostExposed).toEqual(["x-total-count"]);
  });

  it("does not duplicate set-auth-token when the host already exposes it (case-insensitive)", async () => {
    const app = await buildApp({
      origin: true,
      exposedHeaders: ["Set-Auth-Token"],
    });

    const res = await app.inject({
      method: "GET",
      url: "/anything",
      headers: { origin: "http://spa.test" },
    });
    const exposed = String(res.headers["access-control-expose-headers"]).toLowerCase();
    expect(exposed.match(/set-auth-token/g)).toHaveLength(1);
  });
});

describe("Smart CORS — preflight caching (Access-Control-Max-Age)", () => {
  it("defaults maxAge to 86400 so browsers cache the preflight", async () => {
    const app = await buildApp({ origin: true });

    const res = await preflight(app, "content-type");
    expect(res.headers["access-control-max-age"]).toBe("86400");
  });

  it("respects a host-declared maxAge", async () => {
    const app = await buildApp({ origin: true, maxAge: 600 });

    const res = await preflight(app, "content-type");
    expect(res.headers["access-control-max-age"]).toBe("600");
  });

  it("respects an explicit maxAge: 0 opt-out (no default override)", async () => {
    const app = await buildApp({ origin: true, maxAge: 0 });

    const res = await preflight(app, "content-type");
    // @fastify/cors emits 0 verbatim — the point is arc must NOT replace it with 86400.
    expect(res.headers["access-control-max-age"]).not.toBe("86400");
  });
});
