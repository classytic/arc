/**
 * Per-route CORS — `RouteDefinition.cors` → Fastify `routeOptions.config.cors`,
 * which `@fastify/cors` reads as an override.
 *
 * One app-wide policy cannot serve both surfaces: an API wants
 * `credentials: true` with a pinned origin list, a public asset wants
 * `origin: "*"`, and `*` + credentials is forbidden by the CORS spec (arc throws
 * at boot on that pair). Arc forwards the value and lets the plugin own the
 * semantics rather than reimplementing negotiation.
 */

import { describe, expect, it } from "vitest";
import { buildRouteConfig } from "../../src/core/middlewares/rateLimit.js";

describe("buildRouteConfig — cors passthrough", () => {
  it("omits `config` entirely when nothing is set", () => {
    expect(buildRouteConfig(undefined, undefined)).toEqual({});
  });

  it("forwards an object override", () => {
    expect(buildRouteConfig(undefined, undefined, { origin: "*" })).toEqual({
      config: { cors: { origin: "*" } },
    });
  });

  it("forwards `false` — disabling CORS is meaningful, not absence", () => {
    // A truthiness test would silently drop the disable.
    expect(buildRouteConfig(undefined, undefined, false)).toEqual({ config: { cors: false } });
  });

  it("composes with rateLimit and arcExtensions without clobbering", () => {
    const out = buildRouteConfig({ rateLimit: { max: 5, timeWindow: "1m" } }, { a: 1 } as never, {
      origin: "*",
    });
    expect(out.config).toEqual({
      rateLimit: { max: 5, timeWindow: "1m" },
      cors: { origin: "*" },
      arcExtensions: { a: 1 },
    });
  });
});
