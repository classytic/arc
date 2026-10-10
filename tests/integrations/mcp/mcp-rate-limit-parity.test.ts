import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../../src/core/defineResource.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import { allowPublic } from "../../../src/permissions/index.js";
import { resolveResourceRateLimiter } from "../../../src/utils/resourceRateLimit.js";

describe("resource rate-limit transport parity", () => {
  it("shares a tenant budget between REST, MCP operations and callers", async () => {
    const app = Fastify();
    app.decorateRequest("scope", null);
    app.addHook("onRequest", async (req) => {
      req.scope = {
        kind: "member",
        userId: "rest-user",
        userRoles: [],
        organizationId: req.headers["x-org"] as string,
        orgRoles: [],
      };
    });
    await app.register(rateLimit, { global: false });
    const resource = defineResource({
      name: "quota",
      controller: {
        list: async () => ({ data: [] }),
        get: async () => ({ data: { _id: "one" } }),
      },
      permissions: { list: allowPublic(), get: allowPublic() },
      disabledRoutes: ["create", "update", "delete"],
      rateLimit: { max: 2, timeWindow: "1 minute" },
    });
    await app.register(resource.toPlugin());
    await app.ready();
    try {
      const limiter = resolveResourceRateLimiter(app);
      const tools = resourceToTools(resource, { wiring: { rateLimiter: limiter } });
      const list = tools.find((tool) => tool.name === "list_quota");
      const get = tools.find((tool) => tool.name === "get_quota");
      const session = { userId: "mcp-user", organizationId: "org-a", orgRoles: [] };
      const ctx = { session, log: async () => {}, extra: {} };
      expect((await app.inject({ url: "/quotas", headers: { "x-org": "org-a" } })).statusCode).toBe(
        200,
      );
      expect((await list?.handler({}, ctx))?.isError).not.toBe(true);
      expect((await get?.handler({ id: "one" }, ctx))?.isError).toBe(true);
      expect((await app.inject({ url: "/quotas", headers: { "x-org": "org-a" } })).statusCode).toBe(
        429,
      );
      expect((await app.inject({ url: "/quotas", headers: { "x-org": "org-b" } })).statusCode).toBe(
        200,
      );
    } finally {
      await app.close();
    }
  });
});
