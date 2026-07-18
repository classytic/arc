import { describe, expect, it, vi } from "vitest";
import { resolveOrgFromHeader } from "../../src/scope/resolveOrgFromHeader.js";
import {
  OrgAccessDeniedError,
  UnauthorizedError,
  ValidationError,
} from "../../src/utils/errors.js";

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    user: undefined,
    scope: undefined,
    ...overrides,
  } as never;
}

function mockReply() {
  const reply: Record<string, unknown> = { sent: false };
  reply.code = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockImplementation(() => {
    reply.sent = true;
    return reply;
  });
  return reply as never;
}

describe("resolveOrgFromHeader()", () => {
  const resolveMembership = vi.fn();
  const hook = resolveOrgFromHeader({ resolveMembership });

  it("does nothing when org header is absent", async () => {
    const req = mockReq({ headers: {} });
    const reply = mockReply();
    await hook(req, reply);
    expect(resolveMembership).not.toHaveBeenCalled();
  });

  it("rejects a REPEATED org header with 400 instead of picking a value", async () => {
    // Duplicate tenant-selection headers are a smuggling signal — neither
    // value can be trusted to steer the membership check.
    resolveMembership.mockClear();
    const req = mockReq({
      headers: { "x-organization-id": ["org-1", "org-evil"] },
      scope: { kind: "authenticated", userId: "u1" },
      user: { id: "u1" },
    });
    await expect(hook(req, mockReply())).rejects.toThrow(ValidationError);
    expect(resolveMembership).not.toHaveBeenCalled();
  });

  // 2.23 — the hook THROWS ArcError subclasses (canonical ErrorContract via
  // the global error handler) instead of hand-rolling the legacy
  // `{ success, error, message }` envelope. Status codes ride on the error.

  it("throws 401 UnauthorizedError when scope is public", async () => {
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "public" },
    });
    await expect(hook(req, mockReply())).rejects.toThrow(UnauthorizedError);
    await expect(hook(req, mockReply())).rejects.toMatchObject({ statusCode: 401 });
  });

  it("throws 401 UnauthorizedError when no scope", async () => {
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: undefined,
    });
    await expect(hook(req, mockReply())).rejects.toThrow(UnauthorizedError);
  });

  it("skips if already elevated (does not downgrade)", async () => {
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "elevated", userId: "u1" },
      user: { id: "u1" },
    });
    const reply = mockReply();
    await hook(req, reply);
    expect(resolveMembership).not.toHaveBeenCalled();
    expect((req as any).scope.kind).toBe("elevated");
  });

  it("throws 401 UnauthorizedError when user is missing", async () => {
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "authenticated", userId: "u1" },
      user: undefined,
    });
    await expect(hook(req, mockReply())).rejects.toThrow(UnauthorizedError);
  });

  it("throws 403 OrgAccessDeniedError when user is not a member", async () => {
    resolveMembership.mockResolvedValue(null);
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "authenticated", userId: "u1" },
      user: { id: "u1" },
    });
    await expect(hook(req, mockReply())).rejects.toThrow(OrgAccessDeniedError);
    resolveMembership.mockResolvedValue(null);
    await expect(hook(req, mockReply())).rejects.toMatchObject({ statusCode: 403 });
  });

  it("sets scope to member when membership resolved", async () => {
    resolveMembership.mockResolvedValue({ roles: ["admin"] });
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "authenticated", userId: "u1" },
      user: { id: "u1" },
    });
    const reply = mockReply();
    await hook(req, reply);
    expect((req as any).scope).toMatchObject({
      kind: "member",
      userId: "u1",
      organizationId: "org-1",
      orgRoles: ["admin"],
    });
  });

  it("preserves adapter-resolved scope.userRoles when upgrading to member", async () => {
    // The JWT adapter normalized roles from the token onto the scope —
    // re-deriving from `user.role` alone (pre-2.23) dropped them.
    resolveMembership.mockResolvedValue({ roles: ["org-admin"] });
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "authenticated", userId: "u1", userRoles: ["support", "auditor"] },
      user: { id: "u1" }, // note: no user.role at all
    });
    await hook(req, mockReply());
    expect((req as any).scope.userRoles).toEqual(["support", "auditor"]);
  });

  it("falls back to user.role when the scope carries no roles", async () => {
    resolveMembership.mockResolvedValue({ roles: ["member"] });
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "authenticated", userId: "u1", userRoles: [] },
      user: { id: "u1", role: "editor,reviewer" },
    });
    await hook(req, mockReply());
    expect((req as any).scope.userRoles).toEqual(["editor", "reviewer"]);
  });

  it("supports custom header name", async () => {
    const customHook = resolveOrgFromHeader({
      header: "x-tenant-id",
      resolveMembership: vi.fn().mockResolvedValue({ roles: ["member"] }),
    });
    const req = mockReq({
      headers: { "x-tenant-id": "t-1" },
      scope: { kind: "authenticated", userId: "u1" },
      user: { id: "u1" },
    });
    const reply = mockReply();
    await customHook(req, reply);
    expect((req as any).scope.organizationId).toBe("t-1");
  });
});
