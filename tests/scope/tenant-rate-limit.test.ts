/**
 * Per-Tenant Rate Limit Key Generator Tests
 *
 * Verifies scope-aware rate limit key generation for multi-tenant isolation.
 */

import { describe, expect, it } from "vitest";

describe("createTenantKeyGenerator", () => {
  it("should use organizationId for member scope", async () => {
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    const keyGen = createTenantKeyGenerator();
    const key = keyGen({
      ip: "1.2.3.4",
      scope: {
        kind: "member",
        userId: "u1",
        userRoles: [],
        organizationId: "org-1",
        orgRoles: ["admin"],
      },
    });

    expect(key).toBe("org-1");
  });

  it("should use userId for authenticated scope without org", async () => {
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    const keyGen = createTenantKeyGenerator();
    const key = keyGen({
      ip: "1.2.3.4",
      scope: { kind: "authenticated", userId: "u1" },
    });

    expect(key).toBe("u1");
  });

  it("should fall back to IP for public scope", async () => {
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    const keyGen = createTenantKeyGenerator();
    const key = keyGen({
      ip: "1.2.3.4",
      scope: { kind: "public" },
    });

    expect(key).toBe("1.2.3.4");
  });

  it("should use elevated org context when available", async () => {
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    const keyGen = createTenantKeyGenerator();
    const key = keyGen({
      ip: "10.0.0.1",
      scope: {
        kind: "elevated",
        userId: "admin-1",
        organizationId: "org-99",
        elevatedBy: "admin-1",
      },
    });

    expect(key).toBe("org-99");
  });

  it("should support custom key strategy", async () => {
    const { createTenantKeyGenerator } = await import("../../src/scope/rateLimitKey.js");

    const keyGen = createTenantKeyGenerator({
      strategy: (ctx) => `custom:${ctx.ip}:${ctx.scope?.kind}`,
    });

    const key = keyGen({
      ip: "1.2.3.4",
      scope: { kind: "public" },
    });

    expect(key).toBe("custom:1.2.3.4:public");
  });
});
