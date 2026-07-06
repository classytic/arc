/**
 * Per-route rate limit (2.20) — a custom `RouteDefinition.rateLimit` overrides
 * the resource / app default for THAT endpoint only.
 *
 * Proves the three-way contract end-to-end through createApp + the real
 * @fastify/rate-limit plugin:
 *   - `{ max, timeWindow }` → tighter than the app default → 429s sooner
 *   - omitted               → inherits the app/resource default (loose)
 *   - `false`               → never throttled
 *
 * Actions deliberately have NO per-action limit (they share one
 * `POST /:id/action` mount) — that constraint is documented on ActionDefinition
 * and covered by "promote to a route" here.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { allowPublic } from "../../src/permissions/index.js";

describe("Per-route rate limit override (2.20)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  async function buildApp() {
    const widget = defineResource({
      name: "widget",
      prefix: "/widget",
      customRoutesOnly: true, // no adapter — custom routes only
      routes: [
        {
          method: "GET",
          path: "/tight",
          permissions: allowPublic(),
          rateLimit: { max: 1, timeWindow: "1 minute" }, // per-route override
          handler: async () => ({ ok: "tight" }),
        },
        {
          method: "GET",
          path: "/loose",
          permissions: allowPublic(),
          handler: async () => ({ ok: "loose" }), // inherits the app default (max 100)
        },
        {
          method: "GET",
          path: "/unlimited",
          permissions: allowPublic(),
          rateLimit: false, // explicitly never throttled
          handler: async () => ({ ok: "unlimited" }),
        },
      ],
    });

    return createApp({
      preset: "testing",
      auth: false,
      logger: false,
      rateLimit: { max: 100, timeWindow: "1 minute" }, // generous app default
      resources: [widget],
    });
  }

  it("a tighter per-route limit 429s sooner than the app default", async () => {
    app = await buildApp();
    const first = await app.inject({ method: "GET", url: "/widget/tight" });
    const second = await app.inject({ method: "GET", url: "/widget/tight" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429); // max:1 beats the app's max:100
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("a route without an override inherits the (loose) app default", async () => {
    app = await buildApp();
    // 5 quick hits — well under the app default of 100, all pass.
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "GET", url: "/widget/loose" });
      expect(r.statusCode).toBe(200);
    }
  });

  it("`rateLimit: false` is never throttled", async () => {
    app = await buildApp();
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "GET", url: "/widget/unlimited" });
      expect(r.statusCode).toBe(200);
    }
  });

  it("routes have independent buckets — hammering /tight doesn't throttle /loose", async () => {
    app = await buildApp();
    await app.inject({ method: "GET", url: "/widget/tight" });
    const tightBlocked = await app.inject({ method: "GET", url: "/widget/tight" });
    expect(tightBlocked.statusCode).toBe(429);

    // /loose is a different route → different bucket → still open.
    const loose = await app.inject({ method: "GET", url: "/widget/loose" });
    expect(loose.statusCode).toBe(200);
  });
});
