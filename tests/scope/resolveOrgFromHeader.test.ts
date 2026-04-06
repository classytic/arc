import { describe, expect, it, vi } from "vitest";
import { resolveOrgFromHeader } from "../../src/scope/resolveOrgFromHeader.js";

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

  it("returns 401 when scope is public", async () => {
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "public" },
    });
    const reply = mockReply();
    await hook(req, reply);
    expect((reply as any).code).toHaveBeenCalledWith(401);
  });

  it("returns 401 when no scope", async () => {
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: undefined,
    });
    const reply = mockReply();
    await hook(req, reply);
    expect((reply as any).code).toHaveBeenCalledWith(401);
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

  it("returns 401 when user is missing", async () => {
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "authenticated", userId: "u1" },
      user: undefined,
    });
    const reply = mockReply();
    await hook(req, reply);
    expect((reply as any).code).toHaveBeenCalledWith(401);
  });

  it("returns 403 when user is not a member", async () => {
    resolveMembership.mockResolvedValue(null);
    const req = mockReq({
      headers: { "x-organization-id": "org-1" },
      scope: { kind: "authenticated", userId: "u1" },
      user: { id: "u1" },
    });
    const reply = mockReply();
    await hook(req, reply);
    expect((reply as any).code).toHaveBeenCalledWith(403);
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
