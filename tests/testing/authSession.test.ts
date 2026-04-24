/**
 * TestAuthSession — unit tests for the unified auth primitive
 */

import { describe, expect, it, vi } from "vitest";
import {
  createBetterAuthProvider,
  createCustomAuthProvider,
  createJwtAuthProvider,
} from "../../src/testing/authSession.js";

// ============================================================================
// Minimal Fastify-ish stub — exposes only `.jwt.sign` so the provider can
// sign payloads. Avoids booting a real Fastify instance just to test an
// injection point.
// ============================================================================

function makeFastifyWithJwt() {
  const sign = vi.fn((payload: Record<string, unknown>) => `signed:${JSON.stringify(payload)}`);
  return { jwt: { sign } } as unknown as import("fastify").FastifyInstance;
}

describe("createJwtAuthProvider", () => {
  it("register + as produces a session with signed token + org header", () => {
    const app = makeFastifyWithJwt();
    const auth = createJwtAuthProvider(app, { defaultOrgId: "org-default" });
    auth.register("admin", { user: { id: "u1", roles: ["admin"] }, orgId: "org-admin" });

    const session = auth.as("admin");
    expect(session.role).toBe("admin");
    expect(session.orgId).toBe("org-admin");
    expect(session.token).toContain("signed:");
    expect(session.headers.authorization).toBe(`Bearer ${session.token}`);
    expect(session.headers["x-organization-id"]).toBe("org-admin");
  });

  it("falls back to defaultOrgId when role config omits orgId", () => {
    const app = makeFastifyWithJwt();
    const auth = createJwtAuthProvider(app, { defaultOrgId: "org-default" });
    auth.register("member", { user: { id: "u2", roles: ["user"] } });

    expect(auth.as("member").orgId).toBe("org-default");
    expect(auth.as("member").headers["x-organization-id"]).toBe("org-default");
  });

  it("accepts a pre-signed token and skips signing", () => {
    const app = makeFastifyWithJwt();
    const auth = createJwtAuthProvider(app);
    auth.register("bot", { token: "pre-signed-token" });

    expect(auth.as("bot").token).toBe("pre-signed-token");
    expect(vi.mocked(app.jwt!.sign).mock.calls.length).toBe(0);
  });

  it("withExtra merges headers without mutating the original session", () => {
    const app = makeFastifyWithJwt();
    const auth = createJwtAuthProvider(app);
    auth.register("admin", { user: { id: "u1" } });

    const base = auth.as("admin");
    const traced = base.withExtra({ "x-trace-id": "trace-123" });

    expect(traced.headers["x-trace-id"]).toBe("trace-123");
    expect(traced.headers.authorization).toBe(base.headers.authorization);
    expect(base.headers).not.toHaveProperty("x-trace-id");
  });

  it("throws on unknown role (with helpful diagnostic)", () => {
    const app = makeFastifyWithJwt();
    const auth = createJwtAuthProvider(app);
    auth.register("admin", { user: { id: "u1" } });

    expect(() => auth.as("ghost")).toThrow(/unknown role.*Registered.*admin/);
  });

  it("throws at register-time when neither user nor token is supplied", () => {
    const app = makeFastifyWithJwt();
    const auth = createJwtAuthProvider(app);
    expect(() => auth.register("empty", {})).toThrow(/supply either 'user'.*or 'token'/);
  });

  it("throws at as() when app.jwt.sign is missing (JWT plugin not registered)", () => {
    const app = {} as import("fastify").FastifyInstance;
    const auth = createJwtAuthProvider(app);
    auth.register("admin", { user: { id: "u1" } });
    expect(() => auth.as("admin")).toThrow(/app\.jwt\.sign\(\) is unavailable/);
  });

  it("anonymous session has empty headers and empty token", () => {
    const app = makeFastifyWithJwt();
    const auth = createJwtAuthProvider(app);
    const anon = auth.anonymous();
    expect(anon.token).toBe("");
    expect(anon.headers).toEqual({});
    expect(anon.withExtra({ "x-custom": "v" }).headers).toEqual({ "x-custom": "v" });
  });

  it("roles reflects registered keys in insertion order", () => {
    const app = makeFastifyWithJwt();
    const auth = createJwtAuthProvider(app);
    auth.register("admin", { user: {} });
    auth.register("member", { user: {} });
    expect(auth.roles).toEqual(["admin", "member"]);
  });
});

describe("createBetterAuthProvider", () => {
  it("uses pre-signed tokens verbatim", () => {
    const auth = createBetterAuthProvider({ defaultOrgId: "org-1" });
    auth.register("admin", { token: "ba-token-admin" });

    const session = auth.as("admin");
    expect(session.token).toBe("ba-token-admin");
    expect(session.headers.authorization).toBe("Bearer ba-token-admin");
    expect(session.headers["x-organization-id"]).toBe("org-1");
  });

  it("throws when a role config supplies only `user` (payload) instead of `token`", () => {
    const auth = createBetterAuthProvider();
    auth.register("admin", { user: { id: "u1" } });
    expect(() => auth.as("admin")).toThrow(/requires a pre-signed 'token'/);
  });
});

describe("createCustomAuthProvider", () => {
  it("delegates token minting to the supplied function", () => {
    const mint = vi.fn((role: string) => `custom:${role}`);
    const auth = createCustomAuthProvider(mint);
    auth.register("admin", { user: { id: "u1" }, orgId: "org-x" });

    const session = auth.as("admin");
    expect(session.token).toBe("custom:admin");
    expect(session.headers["x-organization-id"]).toBe("org-x");
    expect(mint).toHaveBeenCalledWith("admin", expect.objectContaining({ orgId: "org-x" }));
  });

  it("role configs can carry extraHeaders that flow through every session", () => {
    const auth = createCustomAuthProvider(() => "t");
    auth.register("admin", { token: "t", extraHeaders: { "x-flag": "on" } });
    const session = auth.as("admin");
    expect(session.headers["x-flag"]).toBe("on");
    // withExtra overrides take precedence
    expect(session.withExtra({ "x-flag": "off" }).headers["x-flag"]).toBe("off");
  });
});
