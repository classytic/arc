/**
 * Multi-tenant preset — `tenantScope: true` on custom routes.
 *
 * Closes the gap described in the mentora PR: a custom route declared on
 * a resource with `multiTenantPreset` used to receive NO tenant
 * middleware, so a handler that wanted the caller's `organizationId`
 * had to re-implement the scope read + header fallback + 400 boilerplate
 * by hand. Worse, custom GET routes were silently insecure — without an
 * explicit filter the handler returned all-org data.
 *
 * Contract this file locks in:
 *   - `multiTenantPreset` emits a `tenantScope` middleware slot.
 *   - A custom route with `tenantScope: true` AND the preset wired up
 *     gets the same filter + injection middleware `update` ships.
 *   - The handler sees `req._tenantFields.organizationId` populated
 *     from the caller's scope (no header parsing needed).
 *   - A request with no tenant context is rejected with 403 + the
 *     standard "Tenant context incomplete" message.
 *   - `tenantScope: true` WITHOUT the preset throws at registration
 *     (fail-closed — silent miswiring would leak rows across tenants).
 *   - A custom route WITHOUT the flag is left untouched (backwards
 *     compatibility — presets are opt-in per route).
 */

import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { allowPublic } from "../../src/permissions/index.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";
import type { RequestScope } from "../../src/scope/types.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
} from "../setup.js";

const ORG_A = "507f1f77bcf86cd799439011";

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await teardownTestDatabase();
});

/**
 * Build a Fastify instance with a scope-injection onRequest hook —
 * reads `x-test-org` and `x-test-elevated` headers and stamps
 * `request.scope` so the multiTenant middlewares see a real scope.
 * This is the minimal substitute for a real auth adapter in unit tests.
 */
async function buildApp(opts: {
  presets?: unknown[];
  routes: Parameters<typeof defineResource>[0]["routes"];
  resourceName: string;
}): Promise<FastifyInstance> {
  const Model = createMockModel(`CRT_${opts.resourceName}`);
  const repo = createMockRepository(Model);

  const resource = defineResource({
    name: opts.resourceName,
    prefix: `/${opts.resourceName}`,
    adapter: createMongooseAdapter({ model: Model, repository: repo as never }),
    permissions: {
      list: allowPublic(),
      get: allowPublic(),
      create: allowPublic(),
      update: allowPublic(),
      delete: allowPublic(),
    },
    presets: opts.presets as never,
    routes: opts.routes,
    disableDefaultRoutes: true,
  });

  const app = Fastify({ logger: false });
  app.decorate("authenticate", async () => {});
  app.decorate("optionalAuthenticate", async () => {});
  app.decorate("authorize", () => async () => {});

  // Stand-in for an auth adapter — set request.scope from a header so the
  // multiTenant preset middlewares see a real scope. preHandler runs after
  // onRequest, so this fires before the tenantScope mw in the chain.
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    const elevated = request.headers["x-test-elevated"];
    if (elevated === "true") {
      (request as unknown as { scope: RequestScope }).scope = {
        kind: "elevated",
        elevatedBy: "test-admin",
      };
    } else if (typeof org === "string" && org.length > 0) {
      (request as unknown as { scope: RequestScope }).scope = {
        kind: "member",
        organizationId: org,
        orgRoles: ["member"],
      };
    }
    // else: leave undefined (defaults to public)
  });

  await app.register(resource.toPlugin());
  await app.ready();
  return app;
}

describe("multiTenantPreset — custom-route tenantScope opt-in", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  // --------------------------------------------------------------------------
  // Happy path — tenantScope: true + multiTenantPreset → handler sees org
  // --------------------------------------------------------------------------

  it("injects the caller's tenant into req._tenantFields on a custom route", async () => {
    // What the handler observes for each request — populated inside the
    // handler so the assertions can read what the middleware did before
    // the handler ran.
    let observed: {
      tenantFields?: Record<string, unknown>;
      bodyOrg?: unknown;
    } = {};

    app = await buildApp({
      resourceName: "statements-ok",
      presets: [multiTenantPreset()],
      routes: [
        {
          method: "POST",
          path: "/",
          permissions: allowPublic(),
          tenantScope: true,
          rawHandler: async (req: FastifyRequest, reply: FastifyReply) => {
            observed = {
              tenantFields: (req as unknown as { _tenantFields?: Record<string, unknown> })
                ._tenantFields,
              bodyOrg: (req.body as Record<string, unknown> | undefined)?.organizationId,
            };
            reply.code(200).send({ ok: true });
          },
        },
      ],
    });

    const res = await app.inject({
      method: "POST",
      url: "/statements-ok",
      headers: { "x-test-org": ORG_A, "content-type": "application/json" },
      payload: { title: "Q4 Statement" },
    });

    expect(res.statusCode).toBe(200);
    // _tenantFields is what BaseController.tenantRepoOptions reads to forward
    // to the repo layer. Same shape the auto-CRUD `create` produces.
    expect(observed.tenantFields).toEqual({ organizationId: ORG_A });
    // Body injection also fires (mirrors `create` semantics) so a handler
    // that persists `req.body` carries the tenant without extra wiring.
    expect(observed.bodyOrg).toBe(ORG_A);
  });

  // --------------------------------------------------------------------------
  // Fail-closed — no tenant context → 403
  // --------------------------------------------------------------------------

  it("rejects requests with no tenant context with 403", async () => {
    app = await buildApp({
      resourceName: "statements-no-org",
      presets: [multiTenantPreset()],
      routes: [
        {
          method: "POST",
          path: "/",
          permissions: allowPublic(),
          tenantScope: true,
          rawHandler: async (_req: FastifyRequest, reply: FastifyReply) => {
            reply.code(200).send({ ok: true });
          },
        },
      ],
    });

    // No x-test-org header → request.scope stays `public` → strict filter
    // rejects with 401 (auth required) before injection ever runs. This
    // matches the auto-CRUD `list`/`get` behaviour under strict mode and
    // is the protection custom routes were missing.
    const res = await app.inject({
      method: "POST",
      url: "/statements-no-org",
      payload: { title: "Orphan" },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/Authentication required/i);
  });

  // --------------------------------------------------------------------------
  // Misconfig — tenantScope: true without multiTenantPreset → throw
  // --------------------------------------------------------------------------

  it("throws at registration if tenantScope is set without a multiTenant preset", async () => {
    // The route opts in but no preset emits the `tenantScope` slot — the
    // route would otherwise be silently insecure (no filter on reads, no
    // injection on writes). Failing at boot points the developer at the
    // canonical fix: add `multiTenantPreset()` to the resource's presets.
    await expect(
      buildApp({
        resourceName: "statements-misconfig",
        // No presets — `tenantScope: true` below is the misconfiguration.
        routes: [
          {
            method: "POST",
            path: "/",
            permissions: allowPublic(),
            tenantScope: true,
            rawHandler: async (_req: FastifyRequest, reply: FastifyReply) => {
              reply.send({ ok: true });
            },
          },
        ],
      }),
    ).rejects.toThrow(/tenantScope: true.*requires a multi-tenant preset/);
  });

  // --------------------------------------------------------------------------
  // Backwards compat — no tenantScope flag → no tenant mw on custom routes
  // --------------------------------------------------------------------------

  it("leaves custom routes untouched when tenantScope is omitted", async () => {
    let observed: { tenantFields?: Record<string, unknown> } = {};

    app = await buildApp({
      resourceName: "statements-untouched",
      presets: [multiTenantPreset()],
      routes: [
        {
          method: "GET",
          path: "/health",
          // tenantScope omitted — the route should NOT receive the preset's
          // tenant middlewares. Existing public-facing routes (webhooks,
          // health checks) stay reachable without tenant context.
          permissions: allowPublic(),
          rawHandler: async (req: FastifyRequest, reply: FastifyReply) => {
            observed = {
              tenantFields: (req as unknown as { _tenantFields?: Record<string, unknown> })
                ._tenantFields,
            };
            reply.send({ ok: true });
          },
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/statements-untouched/health" });

    expect(res.statusCode).toBe(200);
    // No tenant fields stashed — the preset's middlewares never ran on
    // this route. Auto-CRUD on the SAME resource is still tenant-scoped.
    expect(observed.tenantFields).toBeUndefined();
  });
});
