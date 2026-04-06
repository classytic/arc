import { describe, expect, it } from "vitest";
import { createTenantKeyGenerator } from "../../src/scope/rateLimitKey.js";
import type { RequestScope } from "../../src/scope/types.js";

describe("createTenantKeyGenerator()", () => {
  const generator = createTenantKeyGenerator();

  it("returns IP for public scope", () => {
    const key = generator({ ip: "1.2.3.4", scope: { kind: "public" } as RequestScope });
    expect(key).toBe("1.2.3.4");
  });

  it("returns IP when no scope", () => {
    const key = generator({ ip: "1.2.3.4" });
    expect(key).toBe("1.2.3.4");
  });

  it("returns userId for authenticated scope", () => {
    const key = generator({
      ip: "1.2.3.4",
      scope: { kind: "authenticated", userId: "u1" } as RequestScope,
    });
    expect(key).toBe("u1");
  });

  it("falls back to IP for authenticated scope without userId", () => {
    const key = generator({
      ip: "1.2.3.4",
      scope: { kind: "authenticated" } as RequestScope,
    });
    expect(key).toBe("1.2.3.4");
  });

  it("returns organizationId for member scope", () => {
    const key = generator({
      ip: "1.2.3.4",
      scope: { kind: "member", organizationId: "org-1", userId: "u1" } as RequestScope,
    });
    expect(key).toBe("org-1");
  });

  it("returns organizationId for elevated scope", () => {
    const key = generator({
      ip: "1.2.3.4",
      scope: { kind: "elevated", organizationId: "org-1", userId: "u1" } as RequestScope,
    });
    expect(key).toBe("org-1");
  });

  it("falls back to userId for elevated scope without orgId", () => {
    const key = generator({
      ip: "1.2.3.4",
      scope: { kind: "elevated", userId: "u1" } as RequestScope,
    });
    expect(key).toBe("u1");
  });

  it("falls back to IP for elevated scope without orgId or userId", () => {
    const key = generator({
      ip: "1.2.3.4",
      scope: { kind: "elevated" } as RequestScope,
    });
    expect(key).toBe("1.2.3.4");
  });

  it("supports custom strategy override", () => {
    const custom = createTenantKeyGenerator({
      strategy: (ctx) => `custom:${ctx.ip}`,
    });
    expect(custom({ ip: "5.6.7.8" })).toBe("custom:5.6.7.8");
  });
});
