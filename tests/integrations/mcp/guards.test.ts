/**
 * MCP Guard Tests
 *
 * Tests permission helpers for custom MCP tools:
 * - Check functions (isAuthenticated, hasOrg, getUserId, etc.)
 * - Guard factories (requireAuth, requireOrg, requireRole, customGuard)
 * - guard() wrapper composability
 * - Integration with defineTool + createMcpServer
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isAuthenticated,
  hasOrg,
  isOrg,
  getUserId,
  getOrgId,
  denied,
  guard,
  requireAuth,
  requireOrg,
  requireRole,
  requireOrgId,
  customGuard,
  defineTool,
  createMcpServer,
  type AuthRef,
} from "../../../src/integrations/mcp/index.js";
import type { ToolContext } from "../../../src/integrations/mcp/types.js";

// ============================================================================
// Helpers
// ============================================================================

function ctx(session: ToolContext["session"]): ToolContext {
  return {
    session,
    log: async () => {},
    extra: {},
  };
}

async function connectInMemory(server: unknown) {
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0" });
  await Promise.all([client.connect(ct), (server as any).connect(st)]);
  return client;
}

// ============================================================================
// Check Functions
// ============================================================================

describe("Check functions", () => {
  it("isAuthenticated — true for real user", () => {
    expect(isAuthenticated(ctx({ userId: "u1" }))).toBe(true);
  });

  it("isAuthenticated — false for anonymous", () => {
    expect(isAuthenticated(ctx({ userId: "anonymous" }))).toBe(false);
  });

  it("isAuthenticated — false for null session", () => {
    expect(isAuthenticated(ctx(null))).toBe(false);
  });

  it("hasOrg — true when org present", () => {
    expect(hasOrg(ctx({ userId: "u1", organizationId: "org-1" }))).toBe(true);
  });

  it("hasOrg — false when no org", () => {
    expect(hasOrg(ctx({ userId: "u1" }))).toBe(false);
  });

  it("isOrg — matches specific org", () => {
    expect(isOrg(ctx({ userId: "u1", organizationId: "org-a" }), "org-a")).toBe(true);
    expect(isOrg(ctx({ userId: "u1", organizationId: "org-a" }), "org-b")).toBe(false);
  });

  it("getUserId — returns id for real user", () => {
    expect(getUserId(ctx({ userId: "u1" }))).toBe("u1");
  });

  it("getUserId — undefined for anonymous", () => {
    expect(getUserId(ctx({ userId: "anonymous" }))).toBeUndefined();
  });

  it("getOrgId — returns org", () => {
    expect(getOrgId(ctx({ userId: "u1", organizationId: "org-1" }))).toBe("org-1");
  });
});

// ============================================================================
// Denied Helper
// ============================================================================

describe("denied()", () => {
  it("returns isError CallToolResult", () => {
    const result = denied("Not allowed");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "Not allowed" });
  });
});

// ============================================================================
// Built-in Guards
// ============================================================================

describe("Built-in guards", () => {
  it("requireAuth — passes for authenticated", () => {
    expect(requireAuth(ctx({ userId: "u1" }))).toBeNull();
  });

  it("requireAuth — fails for anonymous", () => {
    expect(requireAuth(ctx({ userId: "anonymous" }))).toBe("Authentication required");
  });

  it("requireAuth — fails for null session", () => {
    expect(requireAuth(ctx(null))).toBe("Authentication required");
  });

  it("requireOrg — passes with org", () => {
    expect(requireOrg(ctx({ userId: "u1", organizationId: "org-1" }))).toBeNull();
  });

  it("requireOrg — fails without org", () => {
    expect(requireOrg(ctx({ userId: "u1" }))).toBe("Organization context required");
  });

  it("requireRole — passes when user has role", () => {
    const g = requireRole("admin");
    expect(g(ctx({ userId: "u1", roles: ["admin", "user"] }))).toBeNull();
  });

  it("requireRole — fails when user lacks role", () => {
    const g = requireRole("admin");
    expect(g(ctx({ userId: "u1", roles: ["user"] }))).toContain("Required role");
  });

  it("requireRole — fails for unauthenticated", () => {
    const g = requireRole("admin");
    expect(g(ctx(null))).toBe("Authentication required");
  });

  it("requireRole — multiple roles (any match)", () => {
    const g = requireRole("admin", "superadmin");
    expect(g(ctx({ userId: "u1", roles: ["superadmin"] }))).toBeNull();
    expect(g(ctx({ userId: "u1", roles: ["user"] }))).toContain("Required role");
  });

  it("requireOrgId — passes for matching org", () => {
    const g = requireOrgId("org-x");
    expect(g(ctx({ userId: "u1", organizationId: "org-x" }))).toBeNull();
  });

  it("requireOrgId — fails for wrong org", () => {
    const g = requireOrgId("org-x");
    expect(g(ctx({ userId: "u1", organizationId: "org-y" }))).toContain("org-x");
  });
});

// ============================================================================
// Custom Guard
// ============================================================================

describe("customGuard()", () => {
  it("passes when predicate returns true", async () => {
    const g = customGuard(() => true, "Blocked");
    expect(await g(ctx({ userId: "u1" }))).toBeNull();
  });

  it("fails when predicate returns false", async () => {
    const g = customGuard(() => false, "Not during maintenance");
    expect(await g(ctx({ userId: "u1" }))).toBe("Not during maintenance");
  });

  it("supports async predicates", async () => {
    const g = customGuard(async () => true, "Async blocked");
    expect(await g(ctx({ userId: "u1" }))).toBeNull();
  });
});

// ============================================================================
// guard() Wrapper — Composability
// ============================================================================

describe("guard() wrapper", () => {
  it("runs handler when all guards pass", async () => {
    const handler = guard(requireAuth, async (_input, _ctx) => ({
      content: [{ type: "text" as const, text: "success" }],
    }));

    const result = await handler({}, ctx({ userId: "u1" }));
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe("success");
  });

  it("rejects when first guard fails", async () => {
    const handler = guard(requireAuth, requireOrg, async () => ({
      content: [{ type: "text" as const, text: "should not reach" }],
    }));

    const result = await handler({}, ctx(null));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("Authentication required");
  });

  it("rejects when second guard fails", async () => {
    const handler = guard(requireAuth, requireOrg, async () => ({
      content: [{ type: "text" as const, text: "should not reach" }],
    }));

    const result = await handler({}, ctx({ userId: "u1" }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("Organization context required");
  });

  it("composes multiple guards", async () => {
    const handler = guard(
      requireAuth,
      requireOrg,
      requireRole("admin"),
      async (_input, _ctx) => ({
        content: [{ type: "text" as const, text: "admin action done" }],
      }),
    );

    // All pass
    const ok = await handler({}, ctx({ userId: "u1", organizationId: "org-1", roles: ["admin"] }));
    expect(ok.isError).toBeFalsy();

    // Missing role
    const noRole = await handler({}, ctx({ userId: "u1", organizationId: "org-1", roles: ["user"] }));
    expect(noRole.isError).toBe(true);
    expect((noRole.content[0] as { text: string }).text).toContain("Required role");
  });
});

// ============================================================================
// Integration — guard + defineTool + createMcpServer
// ============================================================================

describe("Guard integration with createMcpServer", () => {
  it("guarded tool rejects unauthenticated via MCP client", async () => {
    const server = await createMcpServer({
      name: "test",
      tools: [
        defineTool("admin_action", {
          description: "Admin only action",
          handler: guard(requireAuth, requireOrg, async (_input, ctx) => ({
            content: [{ type: "text", text: `Done by ${ctx.session?.userId}` }],
          })),
        }),
      ],
    });

    const client = await connectInMemory(server);

    // No authRef → session is null → guard rejects
    const result = await client.callTool({ name: "admin_action", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("Authentication required");
  });

  it("guarded tool passes with proper auth", async () => {
    const authRef: AuthRef = { current: { userId: "admin-1", organizationId: "org-x", roles: ["admin"] } };

    const server = await createMcpServer(
      {
        name: "test",
        tools: [
          defineTool("admin_action", {
            description: "Admin only",
            handler: guard(requireAuth, requireOrg, async (_input, ctx) => ({
              content: [{ type: "text", text: `Done by ${ctx.session?.userId} in ${ctx.session?.organizationId}` }],
            })),
          }),
        ],
      },
      authRef,
    );

    const client = await connectInMemory(server);
    const result = await client.callTool({ name: "admin_action", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe("Done by admin-1 in org-x");
  });

  it("role-guarded tool works end-to-end", async () => {
    const authRef: AuthRef = { current: { userId: "u1", organizationId: "org-1", roles: ["editor"] } };

    const server = await createMcpServer(
      {
        name: "test",
        tools: [
          defineTool("publish", {
            description: "Publish content",
            input: { title: z.string() },
            handler: guard(requireRole("editor", "admin"), async ({ title }, ctx) => ({
              content: [{ type: "text", text: `Published "${title}" by ${ctx.session?.userId}` }],
            })),
          }),
        ],
      },
      authRef,
    );

    const client = await connectInMemory(server);

    // Editor can publish
    const ok = await client.callTool({ name: "publish", arguments: { title: "My Post" } });
    expect(ok.isError).toBeFalsy();
    expect((ok.content[0] as { text: string }).text).toContain("Published");

    // Switch to viewer — should be rejected
    authRef.current = { userId: "u2", organizationId: "org-1", roles: ["viewer"] };
    const rejected = await client.callTool({ name: "publish", arguments: { title: "Blocked" } });
    expect(rejected.isError).toBe(true);
    expect((rejected.content[0] as { text: string }).text).toContain("Required role");
  });
});
