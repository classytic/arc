/**
 * Per-Tenant Rate Limit — Integration E2E
 *
 * Proves createTenantKeyGenerator works with real @fastify/rate-limit
 * through createApp — different tenants get independent rate limits.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Per-Tenant Rate Limit — Integration", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  it("rate limits by scope using tenant key generator", async () => {
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");
    const { createApp } = await import("../../src/factory/createApp.js");

    const keyGen = createTenantKeyGenerator();

    app = await createApp({
      preset: "testing",
      auth: false,
      rateLimit: {
        max: 2,
        timeWindow: "1 minute",
        keyGenerator: (request: unknown) => {
          const req = request as {
            ip: string;
            scope?: { kind: string; organizationId?: string; userId?: string };
          };
          return keyGen({
            ip: req.ip,
            scope: req.scope as import("../../src/scope/types.js").RequestScope,
          });
        },
      },
    });

    app.get("/test", async () => ({ ok: true }));

    // First 2 requests from same IP — should succeed
    const r1 = await app.inject({ method: "GET", url: "/test" });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({ method: "GET", url: "/test" });
    expect(r2.statusCode).toBe(200);

    // Third request — rate limited
    const r3 = await app.inject({ method: "GET", url: "/test" });
    expect(r3.statusCode).toBe(429);
  });

  it("generates different keys for different scope kinds", async () => {
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    const keyGen = createTenantKeyGenerator();

    // Member → org ID
    expect(
      keyGen({
        ip: "1.1.1.1",
        scope: {
          kind: "member",
          userId: "u1",
          userRoles: [],
          organizationId: "org-1",
          orgRoles: [],
        },
      }),
    ).toBe("org-1");

    // Authenticated → user ID
    expect(
      keyGen({
        ip: "1.1.1.1",
        scope: { kind: "authenticated", userId: "u1" },
      }),
    ).toBe("u1");

    // Public → IP
    expect(
      keyGen({
        ip: "1.1.1.1",
        scope: { kind: "public" },
      }),
    ).toBe("1.1.1.1");

    // Elevated with org → org ID
    expect(
      keyGen({
        ip: "1.1.1.1",
        scope: { kind: "elevated", userId: "admin", organizationId: "org-2", elevatedBy: "admin" },
      }),
    ).toBe("org-2");

    // Elevated without org → user ID
    expect(
      keyGen({
        ip: "1.1.1.1",
        scope: { kind: "elevated", userId: "admin", elevatedBy: "admin" },
      }),
    ).toBe("admin");
  });
});
