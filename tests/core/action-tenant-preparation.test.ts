import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { authenticated } from "../../src/permissions/presets.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";

describe("action tenant preparation", () => {
  it.each([false, true])(
    "rejects incomplete tenant dimensions before dispatch or cached replay (cached: %s)",
    async (cached) => {
      const handler = vi.fn(async () => ({ done: true }));
      const resource = defineResource({
        name: "task",
        permissions: authenticated(),
        presets: [
          multiTenantPreset({
            tenantFields: [
              { field: "organizationId", type: "org" },
              { field: "branchId", contextKey: "branchId" },
            ],
          }),
        ],
        actions: { process: { id: false, handler } },
        disableDefaultRoutes: true,
      });
      const app = Fastify();
      if (cached)
        app.decorate("idempotency", {
          middleware: async (_request: unknown, reply: { send: (body: unknown) => unknown }) => {
            reply.send({ cached: true });
          },
        });
      app.decorate("authenticate", async () => {});
      app.decorate("optionalAuthenticate", async () => {});
      app.addHook("onRequest", async (request) => {
        request.user = { id: "u1" };
        request.scope = {
          kind: "member",
          userId: "u1",
          userRoles: [],
          organizationId: "org-a",
          orgRoles: [],
        };
      });
      await app.register(resource.toPlugin());
      try {
        const response = await app.inject({
          method: "POST",
          url: "/tasks/action",
          payload: { action: "process" },
        });
        expect(response.statusCode).toBe(403);
        expect(handler).not.toHaveBeenCalled();
        expect(response.json().message).toContain("branchId");
      } finally {
        await app.close();
      }
    },
  );
  it("runs declared route guards before cached replies", async () => {
    const app = Fastify();
    app.decorate("responseCache", {
      middleware: async (_request: unknown, reply: { send: (body: unknown) => unknown }) => {
        reply.send({ cached: true });
      },
    });
    app.decorate("authenticate", async () => {});
    app.decorate("optionalAuthenticate", async () => {});
    app.addHook("onRequest", async (request) => {
      request.user = { id: "u1" };
      request.scope = { kind: "authenticated", userId: "u1" };
    });
    const resource = defineResource({
      name: "task",
      adapter: {
        repository: {
          getAll: async () => [],
          getById: async () => null,
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
      permissions: authenticated(),
      routeGuards: [
        async (_request, reply) => {
          reply.code(403).send({ denied: true });
        },
      ],
    });
    await app.register(resource.toPlugin());
    try {
      expect((await app.inject({ method: "GET", url: "/tasks" })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
