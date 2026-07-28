/**
 * Arc 2.30 authorization contract — AuthorizationDecision + normalizeToDecision.
 *
 * A permission check returns a boolean (terse sugar) or an AuthorizationDecision.
 * There is NO legacy PermissionResult. These tests pin the single normalization
 * seam and the allow()/deny() constructors.
 */

import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  applyPermissionResult,
  normalizeToDecision,
} from "../../src/permissions/applyPermissionResult.js";
import { allow, deny } from "../../src/permissions/core.js";
import type { RequestScope } from "../../src/scope/types.js";

type Sink = FastifyRequest & { _policyFilters?: Record<string, unknown>; scope?: RequestScope };
const req = (init: Partial<Sink> = {}) => ({ ...init }) as Sink;

describe("normalizeToDecision", () => {
  it("promotes booleans", () => {
    expect(normalizeToDecision(true)).toEqual({ effect: "allow" });
    expect(normalizeToDecision(false)).toEqual({ effect: "deny" });
  });

  it("passes a decision through unchanged", () => {
    const d = { effect: "allow", policy: { organizationId: "o1" } } as const;
    expect(normalizeToDecision(d)).toBe(d);
  });
});

describe("allow() / deny() constructors", () => {
  it("allow() with no args is a bare grant", () => {
    expect(allow()).toEqual({ effect: "allow" });
  });

  it("allow(extra) carries policy + scope", () => {
    const scope: RequestScope = { kind: "service", clientId: "c1", organizationId: "o1" };
    expect(allow({ policy: { userId: "u1" }, scope })).toEqual({
      effect: "allow",
      policy: { userId: "u1" },
      scope,
    });
  });

  it("deny() carries an optional reason", () => {
    expect(deny()).toEqual({ effect: "deny" });
    expect(deny("nope")).toEqual({ effect: "deny", reason: "nope" });
  });
});

describe("applyPermissionResult applies a decision", () => {
  it("conjoins the data policy into _policyFilters on allow", () => {
    const r = req();
    applyPermissionResult(allow({ policy: { userId: "u1" } }), r);
    expect(r._policyFilters).toEqual({ userId: "u1" });
  });

  it("no-ops on deny", () => {
    const r = req();
    applyPermissionResult(deny("x"), r);
    expect(r._policyFilters).toBeUndefined();
  });

  it("installs scope but never downgrades an authenticated one", () => {
    const service: RequestScope = { kind: "service", clientId: "c1", organizationId: "o1" };
    const member: RequestScope = {
      kind: "member",
      userId: "u1",
      userRoles: [],
      organizationId: "o1",
      orgRoles: ["admin"],
    };
    const fresh = req();
    applyPermissionResult(allow({ scope: service }), fresh);
    expect(fresh.scope).toEqual(service);

    const authed = req({ scope: member });
    applyPermissionResult(allow({ scope: service }), authed);
    expect(authed.scope).toEqual(member);
  });
});
