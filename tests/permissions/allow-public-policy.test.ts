/**
 * `allowPublic({ policy })` — a public gate that row-filters what it admits.
 *
 * The contract, unit level (the HTTP behaviour is pinned in
 * `allow-public-policy.http.test.ts`):
 *   - `allowPublic()` is unchanged — public, no policy, no new metadata;
 *   - a static policy is returned on every allow, and a mistake in it (empty,
 *     wrong type) fails at DEFINITION time, not on the first request;
 *   - a resolver sees the caller, can return a different filter per caller,
 *     returns `{}` to mean "unrestricted", and FAILS CLOSED when it returns
 *     nothing — a forgotten branch must never read as "no filter";
 *   - introspection reports `rowFiltered`, through `allOf` / `anyOf` too, with
 *     `anyOf` following evaluation order (the first public branch decides what
 *     an anonymous caller sees).
 */

import { describe, expect, it } from "vitest";
import { describePermissionForOpenApi } from "../../src/docs/openapi/operations.js";
import {
  allOf,
  allowPublic,
  anyOf,
  describePermission,
  explainAccess,
  requireRoles,
} from "../../src/permissions/index.js";
import type { PermissionContext } from "../../src/permissions/types.js";

const anonymous = {
  user: null,
  resource: "review",
  action: "list",
} as unknown as PermissionContext;
const author = {
  user: { id: "u1" },
  resource: "review",
  action: "list",
} as unknown as PermissionContext;

const VISIBLE = { status: { $in: ["published", "flagged"] } };

describe("allowPublic() — unchanged", () => {
  it("is public, grants, and carries no policy or row metadata", async () => {
    const check = allowPublic();
    expect(await check(anonymous)).toBe(true);
    expect(check._isPublic).toBe(true);
    expect(check._rowPolicy).toBeUndefined();
    expect(describePermission(check)).toEqual({ kind: "public" });
  });

  it("allowPublic({}) with no policy is the same plain gate", async () => {
    const check = allowPublic({});
    expect(await check(anonymous)).toBe(true);
    expect(check._rowPolicy).toBeUndefined();
  });
});

describe("allowPublic({ policy }) — static", () => {
  it("allows everyone and attaches the policy", async () => {
    const check = allowPublic({ policy: VISIBLE });
    expect(await check(anonymous)).toEqual({ effect: "allow", policy: VISIBLE });
    expect(await check(author)).toEqual({ effect: "allow", policy: VISIBLE });
  });

  it("stays public — the whole point is that anonymous callers are admitted", () => {
    const check = allowPublic({ policy: VISIBLE });
    expect(check._isPublic).toBe(true);
    expect(check._rowPolicy).toBe(true);
  });

  it("returns the policy unchanged across requests (it is shared, so it must not be mutated)", async () => {
    const policy = { status: "published" };
    const check = allowPublic({ policy });
    await check(anonymous);
    await check(author);
    expect(policy).toEqual({ status: "published" });
  });

  it("refuses {} at definition time — it filters nothing, which is almost certainly a mistake", () => {
    expect(() => allowPublic({ policy: {} })).toThrow(/filters nothing/);
  });

  it("refuses a non-object policy at definition time", () => {
    expect(() => allowPublic({ policy: null as never })).toThrow(/null/);
    expect(() => allowPublic({ policy: [] as never })).toThrow(/an array/);
    expect(() => allowPublic({ policy: "published" as never })).toThrow(/string/);
  });

  it("accepts a symbol-keyed-only policy (a branded adapter-native filter)", async () => {
    const brand = Symbol("native");
    const policy = { [brand]: { native: true } } as Record<string | symbol, unknown>;
    const check = allowPublic({ policy: policy as never });
    expect(check._rowPolicy).toBe(true);
    expect(await check(anonymous)).toMatchObject({ effect: "allow" });
  });
});

describe("allowPublic({ policy }) — resolver", () => {
  const scoped = allowPublic({
    policy: (ctx) => {
      const userId = (ctx.user as { id?: string } | null)?.id;
      return userId ? { $or: [VISIBLE, { authorId: userId }] } : VISIBLE;
    },
  });

  it("gives each caller its own filter from ONE gate", async () => {
    expect(await scoped(anonymous)).toEqual({ effect: "allow", policy: VISIBLE });
    expect(await scoped(author)).toEqual({
      effect: "allow",
      policy: { $or: [VISIBLE, { authorId: "u1" }] },
    });
  });

  it("supports an async resolver", async () => {
    const check = allowPublic({ policy: async () => ({ status: "published" }) });
    expect(await check(anonymous)).toEqual({ effect: "allow", policy: { status: "published" } });
  });

  it("returning {} admits the caller unrestricted — the explicit way to say 'no filter'", async () => {
    const check = allowPublic({ policy: () => ({}) });
    expect(await check(anonymous)).toEqual({ effect: "allow" });
  });

  it("FAILS CLOSED when the resolver returns nothing — a fallen-off branch is not 'no filter'", async () => {
    const check = allowPublic({ policy: (() => undefined) as never });
    await expect(check(anonymous)).rejects.toThrow(/review:list/);
    await expect(check(anonymous)).rejects.toThrow(/Return a filter object, or \{\}/);
  });

  it("fails closed on null and on an array too", async () => {
    await expect(allowPublic({ policy: (() => null) as never })(anonymous)).rejects.toThrow(/null/);
    await expect(allowPublic({ policy: (() => []) as never })(anonymous)).rejects.toThrow(
      /an array/,
    );
  });

  it("lets a resolver's own error propagate (arc answers a thrown check with a 403)", async () => {
    const check = allowPublic({
      policy: () => {
        throw new Error("lookup failed");
      },
    });
    await expect(check(anonymous)).rejects.toThrow("lookup failed");
  });

  it("is marked row-filtered even though the filter is only known per request", () => {
    expect(scoped._isPublic).toBe(true);
    expect(scoped._rowPolicy).toBe(true);
  });
});

describe("introspection", () => {
  it("describePermission tells a row-filtered public gate from an open one", () => {
    expect(describePermission(allowPublic({ policy: VISIBLE }))).toEqual({
      kind: "public",
      rowFiltered: true,
    });
    expect(describePermission(allowPublic())).toEqual({ kind: "public" });
  });

  it("explainAccess still says allow, and names the narrowing", () => {
    const result = explainAccess(allowPublic({ policy: VISIBLE }));
    expect(result.decision).toBe("allow");
    expect(result.reason).toMatch(/narrowed by a policy/);
  });

  it("OpenAPI annotation carries rowFiltered", () => {
    expect(describePermissionForOpenApi(allowPublic({ policy: VISIBLE }))).toEqual({
      type: "public",
      rowFiltered: true,
    });
    expect(describePermissionForOpenApi(allowPublic())).toEqual({ type: "public" });
  });
});

describe("composition", () => {
  it("allOf: one row-filtered public branch filters the whole conjunction", async () => {
    const both = allOf(allowPublic({ policy: { status: "published" } }), allowPublic());
    expect(both._isPublic).toBe(true);
    expect(both._rowPolicy).toBe(true);
    expect(await both(anonymous)).toEqual({ effect: "allow", policy: { status: "published" } });

    const open = allOf(allowPublic(), allowPublic());
    expect(open._rowPolicy).toBeUndefined();
  });

  it("allOf conjoins two public policies rather than letting one replace the other", async () => {
    const both = allOf(
      allowPublic({ policy: { status: "published" } }),
      allowPublic({ policy: { locale: "en" } }),
    );
    expect(await both(anonymous)).toEqual({
      effect: "allow",
      policy: { status: "published", locale: "en" },
    });
  });

  it("anyOf: the FIRST public branch decides what an anonymous caller gets", () => {
    // Filtered public branch first → anonymous is filtered.
    expect(anyOf(allowPublic({ policy: VISIBLE }), requireRoles("admin"))._rowPolicy).toBe(true);
    // Admin branch first, filtered public second → anonymous still filtered.
    expect(anyOf(requireRoles("admin"), allowPublic({ policy: VISIBLE }))._rowPolicy).toBe(true);
    // An OPEN public branch first → anonymous sees everything; the later
    // filtered branch is never reached.
    expect(anyOf(allowPublic(), allowPublic({ policy: VISIBLE }))._rowPolicy).toBeUndefined();
  });

  it("anyOf evaluation matches its metadata: the first granting branch's policy is the one applied", async () => {
    const check = anyOf(allowPublic({ policy: VISIBLE }), requireRoles("admin"));
    // The documented trap: an admin is ALSO filtered, because the public
    // branch grants first. Put the admin branch first to exempt admins.
    const admin = {
      user: { id: "a1", role: "admin" },
      resource: "review",
      action: "list",
    } as unknown as PermissionContext;
    expect(await check(admin)).toEqual({ effect: "allow", policy: VISIBLE });
  });
});
