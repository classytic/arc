/**
 * An action's payload is a COMMAND, not a document: tenant preparation scopes the action (filters,
 * `_tenantFields`) but never writes the tenant field into `data`, so a strict command schema keeps
 * passing. A schema refusal thrown by a handler is a 400, never a 500.
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineResource } from "../../src/core/defineResource.js";
import { authenticated } from "../../src/permissions/presets.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";

const command = z.strictObject({ note: z.string() });

async function boot(seen: unknown[]) {
  const resource = defineResource({
    name: "task",
    permissions: authenticated(),
    presets: [multiTenantPreset({ tenantFields: [{ field: "organizationId", type: "org" }] })],
    actions: {
      submit: {
        id: false,
        handler: async (_id: string, data: Record<string, unknown>) => {
          seen.push({ ...data });
          return command.parse(data);
        },
      },
    },
    disableDefaultRoutes: true,
  });
  const app = Fastify();
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
  return app;
}

describe("action payload vs tenant preparation", () => {
  it("does not inject the tenant field into the action's data", async () => {
    const seen: unknown[] = [];
    const app = await boot(seen);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/tasks/action",
        payload: { action: "submit", note: "x" },
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toEqual([{ note: "x" }]);
    } finally {
      await app.close();
    }
  });

  it("a ZodError thrown by the handler is a 400 validation error, not 500", async () => {
    const app = await boot([]);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/tasks/action",
        payload: { action: "submit", note: 5 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("arc.validation_error");
    } finally {
      await app.close();
    }
  });
});
