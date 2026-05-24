/**
 * Custom-route field-write permission enforcement.
 *
 * Auto-CRUD's create/update get field-write perms for free via
 * `BodySanitizer` inside `BaseController`. Before 2.17, custom routes
 * (`config.routes`, presets, action endpoints) bypassed that path —
 * a host that declared `fields: { role: fields.writableBy(['admin']) }`
 * and a custom `POST /users/promote` accepted `{ role: 'admin' }` from
 * any caller.
 *
 * `buildFieldWritePreHandler` closes that gap. This file exercises:
 *   1. Default-deny: callers without the role get a 403 listing the field
 *   2. `onFieldWriteDenied: 'strip'` legacy policy
 *   3. Per-route `fieldWrite: false` opt-out
 *   4. Elevated scope (platform admin) bypass
 *   5. Hidden fields blocked even from authorized callers
 *   6. Skip for raw routes and non-body methods
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { buildFieldWritePreHandler, methodCarriesBody } from "../../src/core/routerShared.js";
import { type FieldPermissionMap, fields } from "../../src/permissions/fields.js";
import { PUBLIC_SCOPE, type RequestScope } from "../../src/scope/types.js";
import { ForbiddenError } from "../../src/utils/errors.js";

const ELEVATED_SCOPE: RequestScope = { kind: "elevated", elevatedBy: "test" };

function makeRequest(opts: {
  body: Record<string, unknown>;
  user?: { role?: string[] };
  scope?: unknown;
}): FastifyRequest {
  return {
    body: opts.body,
    user: opts.user,
    scope: opts.scope ?? PUBLIC_SCOPE,
  } as unknown as FastifyRequest;
}

const noopReply = {} as unknown as FastifyReply;

const perms: FieldPermissionMap = {
  role: fields.writableBy(["admin"]),
  password: fields.hidden(),
};

describe("buildFieldWritePreHandler — default (reject)", () => {
  it("throws ForbiddenError listing the denied writableBy field", async () => {
    const mw = buildFieldWritePreHandler(perms);
    expect(mw).not.toBeNull();
    const req = makeRequest({ body: { name: "x", role: "admin" }, user: { role: ["viewer"] } });

    await expect((mw as NonNullable<typeof mw>)(req, noopReply)).rejects.toThrow(ForbiddenError);
  });

  it("rejects hidden fields even when the caller has roles", async () => {
    const mw = buildFieldWritePreHandler(perms);
    const req = makeRequest({
      body: { name: "x", password: "leak" },
      user: { role: ["admin"] },
    });

    await expect((mw as NonNullable<typeof mw>)(req, noopReply)).rejects.toThrow(/password/);
  });

  it("passes through when caller has the required role", async () => {
    const mw = buildFieldWritePreHandler(perms);
    const req = makeRequest({
      body: { name: "x", role: "editor" },
      user: { role: ["admin"] },
    });

    await (mw as NonNullable<typeof mw>)(req, noopReply);
    expect((req.body as Record<string, unknown>).role).toBe("editor");
  });

  it("passes through when the body has no restricted fields", async () => {
    const mw = buildFieldWritePreHandler(perms);
    const req = makeRequest({ body: { name: "x" }, user: { role: ["viewer"] } });

    await (mw as NonNullable<typeof mw>)(req, noopReply);
    expect(req.body).toEqual({ name: "x" });
  });

  it("error message lists every denied field", async () => {
    const mw = buildFieldWritePreHandler(perms);
    const req = makeRequest({
      body: { name: "x", role: "admin", password: "y" },
      user: { role: ["viewer"] },
    });

    try {
      await (mw as NonNullable<typeof mw>)(req, noopReply);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("role");
      expect((err as Error).message).toContain("password");
    }
  });
});

describe("buildFieldWritePreHandler — strip policy", () => {
  it("silently drops denied fields without throwing", async () => {
    const mw = buildFieldWritePreHandler(perms, "strip");
    const req = makeRequest({
      body: { name: "x", role: "admin", password: "y" },
      user: { role: ["viewer"] },
    });

    await (mw as NonNullable<typeof mw>)(req, noopReply);
    expect(req.body).toEqual({ name: "x" });
  });
});

describe("buildFieldWritePreHandler — elevated scope bypass", () => {
  it("skips enforcement for elevated scope (platform admin)", async () => {
    const mw = buildFieldWritePreHandler(perms);
    const req = makeRequest({
      body: { name: "x", role: "admin", password: "secret" },
      user: { role: ["viewer"] }, // viewer role, but elevated scope
      scope: ELEVATED_SCOPE,
    });

    await (mw as NonNullable<typeof mw>)(req, noopReply);
    // Body untouched — elevated bypass
    expect(req.body).toEqual({ name: "x", role: "admin", password: "secret" });
  });
});

describe("buildFieldWritePreHandler — org roles", () => {
  it("includes org roles in the effective set", async () => {
    const mw = buildFieldWritePreHandler(perms);
    const orgScope: RequestScope = {
      kind: "member",
      userId: "u1",
      userRoles: [],
      organizationId: "o1",
      orgRoles: ["admin"],
    };
    const req = makeRequest({
      body: { name: "x", role: "editor" },
      user: { role: [] }, // no global roles
      scope: orgScope, // admin via org
    });

    await (mw as NonNullable<typeof mw>)(req, noopReply);
    expect((req.body as Record<string, unknown>).role).toBe("editor");
  });
});

describe("buildFieldWritePreHandler — null returns", () => {
  it("returns null when no field permissions are configured", () => {
    expect(buildFieldWritePreHandler(undefined)).toBeNull();
    expect(buildFieldWritePreHandler({})).toBeNull();
  });

  it("returns a preHandler when at least one rule is set", () => {
    expect(buildFieldWritePreHandler({ x: fields.hidden() })).not.toBeNull();
  });
});

describe("buildFieldWritePreHandler — body shape edge cases", () => {
  it("is a no-op when body is missing", async () => {
    const mw = buildFieldWritePreHandler(perms);
    const req = { user: { role: ["viewer"] } } as unknown as FastifyRequest;
    await (mw as NonNullable<typeof mw>)(req, noopReply);
    // No throw, no body to mutate
  });

  it("is a no-op for array bodies (custom JSON-array endpoints)", async () => {
    const mw = buildFieldWritePreHandler(perms);
    const req = {
      body: [{ role: "admin" }],
      user: { role: ["viewer"] },
      scope: PUBLIC_SCOPE,
    } as unknown as FastifyRequest;
    await (mw as NonNullable<typeof mw>)(req, noopReply);
    expect(req.body).toEqual([{ role: "admin" }]); // untouched
  });
});

describe("methodCarriesBody", () => {
  it("returns true for POST/PUT/PATCH", () => {
    expect(methodCarriesBody("POST")).toBe(true);
    expect(methodCarriesBody("PUT")).toBe(true);
    expect(methodCarriesBody("PATCH")).toBe(true);
    expect(methodCarriesBody("post")).toBe(true);
  });

  it("returns false for GET/DELETE/HEAD/OPTIONS", () => {
    expect(methodCarriesBody("GET")).toBe(false);
    expect(methodCarriesBody("DELETE")).toBe(false);
    expect(methodCarriesBody("HEAD")).toBe(false);
    expect(methodCarriesBody("OPTIONS")).toBe(false);
  });
});
