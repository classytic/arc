/**
 * MCP Auth Security Tests
 *
 * Covers:
 * - Anonymous mode (auth: false) must NOT produce truthy ctx.user
 */

import { describe, expect, it } from "vitest";

describe("MCP auth: false security", () => {
  it("auth: false returns null — ctx.user must be null for anonymous callers", async () => {
    const { resolveMcpAuth } = await import("../../../src/integrations/mcp/authBridge.js");

    const result = await resolveMcpAuth({}, false);
    expect(result).toBeNull();
  });

  it("null auth produces public scope and null user", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    const ctx = buildRequestContext({}, null, "list");

    expect(ctx.user).toBeNull();
    const scope = ctx.metadata?._scope as { kind: string };
    expect(scope.kind).toBe("public");
  });

  it("!!ctx.user guard correctly blocks anonymous MCP callers", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    // Simulate auth: false path
    const ctx = buildRequestContext({}, null, "create");

    // This is what a permission check like `create: (ctx) => !!ctx.user` does
    const isAuthenticated = !!ctx.user;
    expect(isAuthenticated).toBe(false);
  });

  it("authenticated user still produces truthy ctx.user", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    const ctx = buildRequestContext({}, { userId: "user-123", organizationId: "org-1" }, "create");

    expect(ctx.user).not.toBeNull();
    expect((ctx.user as Record<string, unknown>)?.id).toBe("user-123");
  });
});
