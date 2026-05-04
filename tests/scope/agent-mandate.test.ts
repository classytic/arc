/**
 * RequestScope.service mandate + dpopJkt fields (additive in 2.13)
 */

import { describe, expect, it } from "vitest";
import {
  getDPoPJkt,
  getMandate,
  isService,
  type Mandate,
  type RequestScope,
} from "../../src/scope/types.js";

describe("RequestScope.service — mandate + dpopJkt accessors", () => {
  const baseService: Extract<RequestScope, { kind: "service" }> = {
    kind: "service",
    clientId: "agent-7",
    organizationId: "acme",
    scopes: ["payment.write"],
  };

  it("getMandate returns undefined for service without mandate", () => {
    expect(getMandate(baseService)).toBeUndefined();
  });

  it("getMandate returns the mandate when present", () => {
    const mandate: Mandate = {
      id: "mnd_1",
      capability: "payment.charge",
      cap: 100,
      currency: "USD",
      expiresAt: Date.now() + 60_000,
      audience: "invoice:INV-7",
    };
    const scope: RequestScope = { ...baseService, mandate };
    expect(getMandate(scope)).toEqual(mandate);
  });

  it("getDPoPJkt returns the JWK thumbprint when set", () => {
    const scope: RequestScope = { ...baseService, dpopJkt: "abc123" };
    expect(getDPoPJkt(scope)).toBe("abc123");
  });

  it("getMandate / getDPoPJkt return undefined for non-service kinds", () => {
    const member: RequestScope = {
      kind: "member",
      userId: "u1",
      userRoles: [],
      organizationId: "acme",
      orgRoles: ["admin"],
    };
    expect(getMandate(member)).toBeUndefined();
    expect(getDPoPJkt(member)).toBeUndefined();
  });

  it("type-narrows service variant correctly", () => {
    const scope: RequestScope = baseService;
    if (isService(scope)) {
      // Compile-time check: mandate + dpopJkt are accessible without `as`
      const m: Mandate | undefined = scope.mandate;
      const j: string | undefined = scope.dpopJkt;
      expect(m).toBeUndefined();
      expect(j).toBeUndefined();
    }
  });
});
