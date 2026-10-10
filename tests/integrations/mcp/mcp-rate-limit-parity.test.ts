import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { defineResource } from "../../../src/core/defineResource.js";
import { idempotencyPlugin } from "../../../src/idempotency/idempotencyPlugin.js";
import { resourceToTools } from "../../../src/integrations/mcp/resourceToTools.js";
import { allowPublic, requireRoles } from "../../../src/permissions/index.js";
import { resolveResourceRateLimiter } from "../../../src/permissions/resourceRateLimit.js";
import { responseCachePlugin } from "../../../src/plugins/response-cache.js";

describe("resource rate-limit transport parity", () => {
  it("shares each explicit route override with MCP while keeping other route budgets separate", async () => {
    const app = Fastify();
    app.decorateRequest("scope", null);
    app.addHook("onRequest", async (req) => {
      req.scope = {
        kind: "member",
        userId: "user",
        userRoles: [],
        organizationId: "org",
        orgRoles: [],
      };
    });
    await app.register(rateLimit, { global: false });
    const policy = { max: 1, timeWindow: "1 minute" };
    const resource = defineResource({
      name: "separate",
      customRoutesOnly: true,
      rateLimit: policy,
      routes: ["/one", "/two", "/default"].map((path) => ({
        method: "GET" as const,
        path,
        permissions: allowPublic(),
        handler: async () => ({ ok: true }),
        ...(path !== "/default" ? { rateLimit: policy } : {}),
      })),
    });
    await app.register(resource.toPlugin());
    await app.ready();
    try {
      const tools = resourceToTools(resource, {
        wiring: { rateLimiter: resolveResourceRateLimiter(app) },
      });
      const one = tools.find((tool) => tool.source?.includes("GET /one"));
      expect(one).toBeDefined();
      if (!one) throw new Error("route tool was not generated");
      expect((await app.inject({ url: "/separates/one" })).statusCode).toBe(200);
      expect(
        (
          await one.handler(
            {},
            {
              session: { userId: "user", organizationId: "org", orgRoles: [] },
              log: async () => {},
              extra: {},
            },
          )
        ).isError,
      ).toBe(true);
      expect((await app.inject({ url: "/separates/two" })).statusCode).toBe(200);
      expect((await app.inject({ url: "/separates/default" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it.each(["responseCache", "idempotency"] as const)(
    "charges %s replays to the resource budget",
    async (plugin) => {
      const method = plugin === "responseCache" ? ("GET" as const) : ("POST" as const);
      const app = Fastify();
      // Fastify also permits string headers; the idempotency store captures those.
      app.addHook("preSerialization", async (_request, reply, payload) => {
        for (const name of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
          const value = reply.getHeader(name);
          if (value !== undefined) reply.header(name, String(value));
        }
        return payload;
      });
      if (plugin === "responseCache") await app.register(responseCachePlugin, { defaultTTL: 60 });
      else await app.register(idempotencyPlugin, { enabled: true });
      await app.register(rateLimit, { global: false });
      const resource = defineResource({
        name: "replay",
        customRoutesOnly: true,
        rateLimit: { max: 2, timeWindow: "1 minute" },
        routes: [
          {
            method,
            path: "/cached",
            permissions: allowPublic(),
            handler: async () => ({ fresh: true }),
          },
        ],
      });
      await app.register(resource.toPlugin());
      await app.ready();
      try {
        const headers = plugin === "idempotency" ? { "idempotency-key": "same" } : {};
        const first = await app.inject({ method, url: "/replays/cached", headers });
        const replay = await app.inject({ method, url: "/replays/cached", headers });
        expect(first.statusCode).toBe(200);
        expect(replay.statusCode).toBe(200);
        expect(first.headers["x-ratelimit-remaining"]).toBe("1");
        expect(replay.headers["x-ratelimit-remaining"]).toBe("0");
        expect(
          replay.headers[plugin === "responseCache" ? "x-cache" : "x-idempotency-replayed"],
        ).toBe(plugin === "responseCache" ? "HIT" : "true");
        expect((await app.inject({ method, url: "/replays/cached", headers })).statusCode).toBe(
          429,
        );
      } finally {
        await app.close();
      }
    },
  );
  it("does not charge denied MCP calls against an admitted REST caller's tenant", async () => {
    const app = Fastify();
    app.decorateRequest("scope", null);
    app.decorateRequest("user", null);
    app.decorate("authenticate", async () => {});
    app.addHook("onRequest", async (req) => {
      req.user = { id: "rest", roles: ["admin"] };
      req.scope = {
        kind: "member",
        userId: "rest",
        userRoles: ["admin"],
        organizationId: "org",
        orgRoles: [],
      };
    });
    await app.register(rateLimit, { global: false });
    const resource = defineResource({
      name: "admission",
      adapter: {
        type: "custom",
        repository: {
          getAll: async () => ({
            method: "offset",
            data: [],
            total: 0,
            page: 1,
            limit: 20,
            pages: 0,
          }),
        },
      },
      disabledRoutes: ["get", "create", "update", "delete"],
      permissions: { list: requireRoles(["admin"]) },
      actions: {
        approve: { permissions: requireRoles(["admin"]), handler: async () => ({ ok: true }) },
      },
      rateLimit: { max: 1, timeWindow: "1 minute" },
      routes: [
        {
          method: "GET",
          path: "/read",
          permissions: requireRoles(["admin"]),
          handler: async () => ({ ok: true }),
        },
      ],
    });
    await app.register(resource.toPlugin());
    try {
      const tools = resourceToTools(resource, {
        wiring: { rateLimiter: resolveResourceRateLimiter(app) },
      });
      expect(tools.length).toBe(3);
      for (const tool of tools) {
        const denied = await tool.handler(
          { id: "one" },
          {
            session: { userId: "mcp", roles: [], organizationId: "org", orgRoles: [] },
            log: async () => {},
            extra: {},
          },
        );
        expect(denied.isError).toBe(true);
      }
      expect((await app.inject({ url: "/admissions/read" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it("refuses a declared HTTP budget when the SDK plugin is missing", async () => {
    const app = Fastify();
    const resource = defineResource({
      name: "missing",
      customRoutesOnly: true,
      rateLimit: { max: 1, timeWindow: "1m" },
      routes: [
        {
          method: "GET",
          path: "/read",
          permissions: allowPublic(),
          handler: async () => ({ ok: true }),
        },
      ],
    });
    try {
      await expect(app.register(resource.toPlugin()).ready()).rejects.toThrow(
        "@fastify/rate-limit",
      );
    } finally {
      await app.close();
    }
  });
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
      adapter: {
        type: "custom",
        repository: {
          getAll: async () => ({
            method: "offset",
            data: [],
            total: 0,
            page: 1,
            limit: 20,
            pages: 0,
          }),
          getById: async () => ({ _id: "one" }),
          create: async (data: unknown) => data,
          update: async () => ({ _id: "one" }),
          delete: async () => true,
        },
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
      const first = await app.inject({ url: "/quotas", headers: { "x-org": "org-a" } });
      expect(first.statusCode, first.body).toBe(200);
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
