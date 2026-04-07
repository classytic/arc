/**
 * Service Scope Tests
 *
 * Verifies the `service` kind on RequestScope — the clean primitive for
 * machine-to-machine auth (API keys, service accounts). Historically users
 * had to fake a `member` scope with `userId: client._id`, which polluted
 * audit logs and made service calls indistinguishable from human calls.
 */

import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_SCOPE,
  getClientId,
  getOrgId,
  getOrgRoles,
  getServiceScopes,
  getUserId,
  getUserRoles,
  hasOrgAccess,
  isAuthenticated,
  isElevated,
  isMember,
  isService,
  PUBLIC_SCOPE,
  type RequestScope,
} from "../../src/scope/types.js";

const service: RequestScope = {
  kind: "service",
  clientId: "client-abc",
  organizationId: "org-acme",
  scopes: ["jobs:write", "memories:read"],
};

const member: RequestScope = {
  kind: "member",
  userId: "user-1",
  userRoles: ["user"],
  organizationId: "org-acme",
  orgRoles: ["admin"],
};

describe("service scope — type guards", () => {
  it("isService narrows to the service variant", () => {
    expect(isService(service)).toBe(true);
    expect(isService(member)).toBe(false);
    expect(isService(PUBLIC_SCOPE)).toBe(false);
    expect(isService(AUTHENTICATED_SCOPE)).toBe(false);
  });

  it("isMember returns false for service (service is not a member)", () => {
    expect(isMember(service)).toBe(false);
  });

  it("isElevated returns false for service", () => {
    expect(isElevated(service)).toBe(false);
  });

  it("isAuthenticated returns true for service (machine is still authenticated)", () => {
    expect(isAuthenticated(service)).toBe(true);
  });

  it("hasOrgAccess returns true for service (bound to an org)", () => {
    expect(hasOrgAccess(service)).toBe(true);
  });
});

describe("service scope — accessors", () => {
  it("getOrgId returns the organizationId", () => {
    expect(getOrgId(service)).toBe("org-acme");
  });

  it("getClientId returns the clientId for service scopes", () => {
    expect(getClientId(service)).toBe("client-abc");
  });

  it("getClientId returns undefined for non-service scopes", () => {
    expect(getClientId(member)).toBeUndefined();
    expect(getClientId(PUBLIC_SCOPE)).toBeUndefined();
    expect(getClientId(AUTHENTICATED_SCOPE)).toBeUndefined();
  });

  it("getUserId returns undefined for service (a client is NOT a user)", () => {
    expect(getUserId(service)).toBeUndefined();
  });

  it("getUserRoles returns an empty array for service", () => {
    expect(getUserRoles(service)).toEqual([]);
  });

  it("getOrgRoles returns an empty array for service (no membership record)", () => {
    expect(getOrgRoles(service)).toEqual([]);
  });

  it("getServiceScopes returns the OAuth-style scope array", () => {
    expect(getServiceScopes(service)).toEqual(["jobs:write", "memories:read"]);
  });

  it("getServiceScopes returns an empty array for non-service scopes", () => {
    expect(getServiceScopes(member)).toEqual([]);
    expect(getServiceScopes(PUBLIC_SCOPE)).toEqual([]);
  });

  it("getServiceScopes returns an empty array when service has no scopes", () => {
    const bare: RequestScope = {
      kind: "service",
      clientId: "c1",
      organizationId: "o1",
    };
    expect(getServiceScopes(bare)).toEqual([]);
  });
});

describe("service scope — public type contract", () => {
  it("requires `organizationId` and `clientId` at the type level", () => {
    // These assertions are checked by tsc — if the type ever drifts (e.g.
    // someone makes organizationId optional), the @ts-expect-error lines
    // below will become "unused" errors and the build will fail.
    //
    // This is the type-level regression pin for bug #5 in the review:
    // "service scope's public type contract conflicts with the runtime
    // rate-limit behavior it documents" — we're pinning the contract so
    // rateLimitKey.ts can safely use `scope.organizationId` without fallback.

    // @ts-expect-error — organizationId is required on service scope
    const missingOrg: RequestScope = { kind: "service", clientId: "c1" };
    // @ts-expect-error — clientId is required on service scope
    const missingClient: RequestScope = { kind: "service", organizationId: "o1" };

    // Suppress unused warnings; these exist only to anchor the @ts-expect-error above.
    void missingOrg;
    void missingClient;

    // Positive case: full service scope compiles cleanly
    const valid: RequestScope = {
      kind: "service",
      clientId: "c1",
      organizationId: "o1",
    };
    expect(valid.kind).toBe("service");
  });
});

describe("service scope — tenant filtering integration", () => {
  it("service scope participates in tenantField filtering via getOrgId", () => {
    // This is the exact path QueryResolver + AccessControl walk:
    //   metadata._scope → getOrgIdFromScope(scope) → tenantField filter
    const orgIdFromService = getOrgId(service);
    const orgIdFromMember = getOrgId(member);

    expect(orgIdFromService).toBe("org-acme");
    expect(orgIdFromMember).toBe("org-acme");

    // Identical org IDs mean BOTH kinds produce identical query filters —
    // service auth gets the same tenant isolation guarantees as human auth.
    expect(orgIdFromService).toEqual(orgIdFromMember);
  });
});
