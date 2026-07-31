/**
 * Tests for `route.controllerMethod` — typed function-ref handlers (2.16).
 *
 * Pre-2.16 routes referenced controller methods via string:
 *     `handler: 'getStats'`
 * which loses TS coverage on typos and surfaces as a boot-time error
 * (`Handler 'getStats' not found on controller`). The OpenAI-team
 * report asked for `handler: (c) => c.getStats` so the compiler catches
 * misspellings at the declaration site.
 *
 * Contract this file locks in:
 *  - `controllerMethod: (c) => c.method` resolves to the bound method
 *    at registration time and dispatches identically to the string form.
 *  - The function-ref form interoperates with the arc pipeline (no
 *    bypass — full request flow runs through it).
 *  - Mutual exclusion with `handler`: passing both throws at boot.
 *  - Passing NEITHER throws (was previously implicit-undefined ignored).
 *  - `controllerMethod` without a controller throws with a clear hint.
 *  - The function returning a non-function throws (defensive bad-config
 *    catcher — TS catches it normally, this is the runtime guard).
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import type { IRequestContext } from "../../src/types/index.js";
import { createMockRepositoryMock } from "../setup.js";

class StatsController extends BaseController<Record<string, unknown>> {
  async getStats(_ctx: IRequestContext) {
    return { data: { totalUsers: 42, totalPosts: 100 } };
  }

  async getActiveCount(_ctx: IRequestContext) {
    return { data: { active: 12 } };
  }
}

function buildController(): StatsController {
  // Mock repo — no DB needed; the custom routes don't touch the
  // repo, they just exercise dispatch.
  const repo = createMockRepositoryMock();
  return new StatsController(repo, { resourceName: "stats" });
}

describe("RouteDefinition.controllerMethod — typed function refs", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("resolves the function-ref to the bound controller method and dispatches", async () => {
    const ctrl = buildController();
    const resource = defineResource({
      name: "stats",
      prefix: "/stats",
      controller: ctrl,
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/summary",
          // The typed form — TS would catch `c.getStas` (typo).
          controllerMethod: (c: StatsController) => c.getStats,
          permissions: allowPublic(),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(resource.toPlugin());
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/stats/summary" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ totalUsers: 42, totalPosts: 100 });
  });

  it("dispatches the SAME way as a string-handler equivalent (parity check)", async () => {
    // The point of the function-ref form is type safety, not semantic
    // change. Both forms should produce identical responses for the
    // same controller method.
    const ctrl = buildController();
    const stringForm = defineResource({
      name: "stats-string",
      prefix: "/stats-string",
      controller: ctrl,
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/active",
          handler: "getActiveCount",
          permissions: allowPublic(),
        },
      ],
    });
    const ctrl2 = buildController();
    const refForm = defineResource({
      name: "stats-ref",
      prefix: "/stats-ref",
      controller: ctrl2,
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/active",
          controllerMethod: (c: StatsController) => c.getActiveCount,
          permissions: allowPublic(),
        },
      ],
    });

    app = Fastify({ logger: false });
    await app.register(stringForm.toPlugin());
    await app.register(refForm.toPlugin());
    await app.ready();

    const a = await app.inject({ method: "GET", url: "/stats-string/active" });
    const b = await app.inject({ method: "GET", url: "/stats-ref/active" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(JSON.parse(a.body)).toEqual(JSON.parse(b.body));
  });

  it("throws when BOTH `handler` and `controllerMethod` are passed", async () => {
    const ctrl = buildController();
    const resource = defineResource({
      name: "stats-both",
      prefix: "/stats-both",
      controller: ctrl,
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/x",
          handler: "getStats",
          controllerMethod: (c: StatsController) => c.getStats,
          permissions: allowPublic(),
        },
      ],
    });
    app = Fastify({ logger: false });
    await expect(app.register(resource.toPlugin())).rejects.toThrow(
      /pass either `handler` or `controllerMethod`, not both/,
    );
  });

  it("throws at defineResource() when NEITHER `handler` nor `controllerMethod` is set", () => {
    // The validator catches this at boot — fail-fast before route
    // registration. Same hint surfaces from the runtime layer as a
    // backstop for hosts that skip validation, but the validator wins
    // when both fire because it runs first.
    const ctrl = buildController();
    expect(() =>
      defineResource({
        name: "stats-none",
        prefix: "/stats-none",
        controller: ctrl,
        permissions: { list: allowPublic(), get: allowPublic() },
        disableDefaultRoutes: true,
        routes: [
          {
            method: "GET",
            path: "/x",
            permissions: allowPublic(),
            // biome-ignore lint/suspicious/noExplicitAny: deliberate misconfig
          } as any,
        ],
      }),
    ).toThrow(/must declare one of `handler`.*`rawHandler`.*or `controllerMethod`/s);
  });

  it("throws when controllerMethod returns a non-function", async () => {
    const ctrl = buildController();
    const resource = defineResource({
      name: "stats-bad",
      prefix: "/stats-bad",
      controller: ctrl,
      permissions: { list: allowPublic(), get: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/x",
          // Bug — returned a value, not a method.
          // biome-ignore lint/suspicious/noExplicitAny: deliberate misconfig
          controllerMethod: ((_c: StatsController) => undefined) as any,
          permissions: allowPublic(),
        },
      ],
    });
    app = Fastify({ logger: false });
    await expect(app.register(resource.toPlugin())).rejects.toThrow(/did not return a function/);
  });

  it("throws when controllerMethod is set without a controller", async () => {
    // No `controller:` and no `adapter:` means arc has nothing to
    // resolve `(c) => c.method` against. The error message points
    // at both fixes: provide a controller, or use an adapter so arc
    // auto-creates one.
    expect(() =>
      defineResource({
        name: "stats-noctrl",
        prefix: "/stats-noctrl",
        permissions: { list: allowPublic() },
        disableDefaultRoutes: true,
        routes: [
          {
            method: "GET",
            path: "/x",
            controllerMethod: (_c: StatsController) => async () => ({}),
            permissions: allowPublic(),
          },
        ],
      }).toPlugin(),
    ).not.toThrow();
    // The throw happens at REGISTRATION time, not defineResource time —
    // confirm via app.register.
    const resource = defineResource({
      name: "stats-noctrl",
      prefix: "/stats-noctrl",
      permissions: { list: allowPublic() },
      disableDefaultRoutes: true,
      routes: [
        {
          method: "GET",
          path: "/x",
          controllerMethod: (_c: StatsController) => async () => ({}),
          permissions: allowPublic(),
        },
      ],
    });
    app = Fastify({ logger: false });
    await expect(app.register(resource.toPlugin())).rejects.toThrow(
      /`controllerMethod` requires a controller/,
    );
  });
});
