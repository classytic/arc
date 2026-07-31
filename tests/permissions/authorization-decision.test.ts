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
  applyAuthorizationDecision,
  normalizeToDecision,
} from "../../src/permissions/authorizationDecision.js";
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

  /**
   * This is a RUNTIME framework boundary: JavaScript hosts and loosely-typed
   * integrations reach it with shapes TypeScript would have rejected. Every
   * downstream branch is `effect !== "allow"`, so anything that slips past the
   * guard becomes an implicit deny — the exact silent failure the guard exists
   * to abolish. Validating the VALUE rather than the key's presence is what
   * makes the promise ("you get a migration error") true.
   */
  it.each([
    ["the pre-2.30 shape", { granted: true }],
    ["a hand-rolled shape", { allowed: true }],
    ["a misspelled effect", { effect: "permit" }],
    ["an explicitly undefined effect", { effect: undefined }],
    ["null", null],
    ["a stray unawaited Promise", Promise.resolve(true)],
  ])("throws a migration error for %s", (_label, value) => {
    expect(() => normalizeToDecision(value as never)).toThrow(/unrecognized shape/);
  });

  it("accepts both valid effects", () => {
    expect(normalizeToDecision({ effect: "allow" })).toEqual({ effect: "allow" });
    expect(normalizeToDecision({ effect: "deny" })).toEqual({ effect: "deny" });
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

describe("applyAuthorizationDecision applies a decision", () => {
  it("conjoins the data policy into _policyFilters on allow", () => {
    const r = req();
    applyAuthorizationDecision(allow({ policy: { userId: "u1" } }), r);
    expect(r._policyFilters).toEqual({ userId: "u1" });
  });

  it("no-ops on deny", () => {
    const r = req();
    applyAuthorizationDecision(deny("x"), r);
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
    applyAuthorizationDecision(allow({ scope: service }), fresh);
    expect(fresh.scope).toEqual(service);

    const authed = req({ scope: member });
    applyAuthorizationDecision(allow({ scope: service }), authed);
    expect(authed.scope).toEqual(member);
  });
});
