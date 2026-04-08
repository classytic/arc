/**
 * Service Scope Protocol Parity Tests
 *
 * Verifies that MCP auth can produce `kind: "service"` RequestScope
 * when clientId is present — enabling requireServiceScope() checks
 * for machine-to-machine / service account auth.
 */

import { describe, expect, it } from "vitest";

describe("MCP service scope", () => {
  it("should produce service scope when clientId is present", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    const ctx = buildRequestContext(
      {},
      {
        userId: "svc-bot",
        organizationId: "org-acme",
        clientId: "client_abc123",
        scopes: ["read:products", "write:orders"],
      },
      "list",
    );

    const scope = ctx.metadata?._scope as { kind: string; clientId?: string; scopes?: readonly string[] };
    expect(scope.kind).toBe("service");
    expect(scope.clientId).toBe("client_abc123");
    expect(scope.scopes).toEqual(["read:products", "write:orders"]);
  });

  it("should produce member scope when clientId is absent", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    const ctx = buildRequestContext(
      {},
      {
        userId: "user-123",
        organizationId: "org-acme",
        roles: ["admin"],
        orgRoles: ["owner"],
      },
      "list",
    );

    const scope = ctx.metadata?._scope as { kind: string; userId?: string; userRoles?: string[]; orgRoles?: string[] };
    expect(scope.kind).toBe("member");
    expect(scope.userId).toBe("user-123");
    expect(scope.userRoles).toEqual(["admin"]);
    expect(scope.orgRoles).toEqual(["owner"]);
  });

  it("should produce authenticated scope when no org", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    const ctx = buildRequestContext(
      {},
      { userId: "user-456", roles: ["viewer"] },
      "get",
    );

    const scope = ctx.metadata?._scope as { kind: string; userId?: string; userRoles?: string[] };
    expect(scope.kind).toBe("authenticated");
    expect(scope.userId).toBe("user-456");
    expect(scope.userRoles).toEqual(["viewer"]);
  });

  it("should produce public scope when auth is null", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    const ctx = buildRequestContext({}, null, "list");

    const scope = ctx.metadata?._scope as { kind: string };
    expect(scope.kind).toBe("public");
  });

  it("service scope should satisfy isService type guard", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );
    const { isService, getClientId, getServiceScopes, hasOrgAccess } = await import(
      "../../../src/scope/types.js"
    );

    const ctx = buildRequestContext(
      {},
      {
        userId: "svc-ingestion",
        organizationId: "org-acme",
        clientId: "client_ingestion_pipeline",
        scopes: ["read:all", "write:events"],
      },
      "create",
    );

    const scope = ctx.metadata?._scope as import("../../../src/scope/types.js").RequestScope;
    expect(isService(scope)).toBe(true);
    expect(getClientId(scope)).toBe("client_ingestion_pipeline");
    expect(getServiceScopes(scope)).toEqual(["read:all", "write:events"]);
    expect(hasOrgAccess(scope)).toBe(true);
  });

  it("service scope without scopes should default to empty array", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );
    const { getServiceScopes } = await import("../../../src/scope/types.js");

    const ctx = buildRequestContext(
      {},
      {
        userId: "svc-minimal",
        organizationId: "org-1",
        clientId: "client_minimal",
      },
      "list",
    );

    const scope = ctx.metadata?._scope as import("../../../src/scope/types.js").RequestScope;
    expect(getServiceScopes(scope)).toEqual([]);
  });

  it("custom MCP auth resolver can return service identity", async () => {
    const { resolveMcpAuth } = await import(
      "../../../src/integrations/mcp/authBridge.js"
    );

    // Simulate a custom auth resolver returning service identity
    const serviceAuth = async (headers: Record<string, string | undefined>) => {
      if (headers["x-service-key"] === "svc-secret-123") {
        return {
          userId: "svc-data-pipeline",
          organizationId: "org-acme",
          clientId: "pipeline-v2",
          scopes: ["read:products", "write:analytics"] as const,
        };
      }
      return null;
    };

    const result = await resolveMcpAuth(
      { "x-service-key": "svc-secret-123" },
      serviceAuth,
    );

    expect(result).not.toBeNull();
    expect(result?.clientId).toBe("pipeline-v2");
    expect(result?.scopes).toEqual(["read:products", "write:analytics"]);
    expect(result?.organizationId).toBe("org-acme");
  });

  it("pure machine principal (no userId) produces service scope with null user", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    const ctx = buildRequestContext(
      {},
      {
        // No userId — pure machine identity
        organizationId: "org-acme",
        clientId: "ingestion-pipeline",
        scopes: ["write:events"],
      },
      "create",
    );

    const scope = ctx.metadata?._scope as import("../../../src/scope/types.js").RequestScope;
    expect(scope.kind).toBe("service");

    // ctx.user should be null — machine principals don't masquerade as users
    expect(ctx.user).toBeNull();
  });

  it("clientId without organizationId should produce authenticated scope (not service)", async () => {
    const { buildRequestContext } = await import(
      "../../../src/integrations/mcp/buildRequestContext.js"
    );

    // Service scope requires both clientId AND organizationId
    const ctx = buildRequestContext(
      {},
      {
        userId: "orphan-client",
        clientId: "client_no_org",
      },
      "list",
    );

    const scope = ctx.metadata?._scope as { kind: string };
    // Without org, it can't be service scope — falls to authenticated
    expect(scope.kind).toBe("authenticated");
  });
});
