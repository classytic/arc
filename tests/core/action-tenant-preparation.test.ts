import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import { authenticated } from "../../src/permissions/presets.js";
import { multiTenantPreset } from "../../src/presets/multiTenant.js";

describe("action tenant preparation", () => {
  it("rejects incomplete tenant dimensions before an id-less handler runs", async () => {
    const handler = vi.fn(async () => ({ done: true }));
    const resource = defineResource({ name: "task", permissions: authenticated(), presets: [multiTenantPreset({ tenantFields: [{ field: "organizationId", type: "org" }, { field: "branchId", contextKey: "branchId" }] })], actions: { process: { id: false, handler } }, disableDefaultRoutes: true });
    const app = Fastify();
    app.decorate("authenticate", async () => {});
    app.decorate("optionalAuthenticate", async () => {});
    app.addHook("onRequest", async (request) => { request.user = { id: "u1" }; request.scope = { kind: "member", userId: "u1", userRoles: [], organizationId: "org-a", orgRoles: [] }; });
    await app.register(resource.toPlugin());
    try {
      const response = await app.inject({ method: "POST", url: "/tasks/action", payload: { action: "process" } });
      expect(response.statusCode).toBe(403);
      expect(handler).not.toHaveBeenCalled();
      expect(response.json().message).toContain("branchId");
    } finally { await app.close(); }
  });
});
