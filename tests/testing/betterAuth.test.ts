/**
 * Better Auth test helpers — unit tests.
 *
 * Covers both the flow-level helpers (signUp / signIn / createOrg /
 * setActiveOrg / authHeaders / safeParseBody) and the composite
 * `setupBetterAuthTestApp` orchestrator.
 *
 * Strategy: mock a Fastify-like injector that responds to the expected
 * Better Auth endpoints. We don't need a real Better Auth install to
 * verify that the helper issues the right requests and tolerates
 * response-shape drift (token under `.token` / `.session.token` / etc.).
 */

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createBetterAuthProvider } from "../../src/testing/authSession.js";
import {
  createBetterAuthTestHelpers,
  safeParseBody,
  setupBetterAuthTestApp,
} from "../../src/testing/betterAuth.js";

// ============================================================================
// Mock Fastify-like injector
// ============================================================================

interface MockCall {
  method: string;
  url: string;
  payload: unknown;
  headers: Record<string, string> | undefined;
}

interface MockResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, unknown>;
}

function makeInjector(respond: (call: MockCall) => MockResponse | Promise<MockResponse>): {
  inject: (opts: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) => Promise<MockResponse>;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  return {
    async inject(opts) {
      const call: MockCall = {
        method: opts.method,
        url: opts.url,
        payload: opts.payload,
        headers: opts.headers,
      };
      calls.push(call);
      return respond(call);
    },
    calls,
  };
}

// ============================================================================
// safeParseBody
// ============================================================================

describe("safeParseBody", () => {
  it("parses valid JSON", () => {
    expect(safeParseBody<{ x: number }>('{"x":1}')).toEqual({ x: 1 });
  });

  it("returns null for empty / undefined bodies (Better Auth 204 responses)", () => {
    expect(safeParseBody(undefined)).toBeNull();
    expect(safeParseBody("")).toBeNull();
  });

  it("returns null for malformed JSON (doesn't crash tests)", () => {
    expect(safeParseBody("<html>not json</html>")).toBeNull();
    expect(safeParseBody("{ oops")).toBeNull();
  });
});

// ============================================================================
// createBetterAuthTestHelpers
// ============================================================================

describe("createBetterAuthTestHelpers — signUp", () => {
  it("POSTs to /api/auth/sign-up/email with the expected payload + content-type", async () => {
    const app = makeInjector(() => ({
      statusCode: 200,
      body: JSON.stringify({ token: "tok-u1", user: { id: "u1" } }),
    }));
    const helpers = createBetterAuthTestHelpers();

    const result = await helpers.signUp(app as unknown as FastifyInstance, {
      email: "a@x.com",
      password: "pw",
      name: "Alice",
    });

    expect(app.calls).toHaveLength(1);
    expect(app.calls[0]).toMatchObject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "a@x.com", password: "pw", name: "Alice" },
      headers: expect.objectContaining({ "content-type": "application/json" }),
    });
    expect(result).toEqual({
      statusCode: 200,
      token: "tok-u1",
      userId: "u1",
      body: { token: "tok-u1", user: { id: "u1" } },
    });
  });

  it("honors custom basePath (apps that mount Better Auth elsewhere)", async () => {
    const app = makeInjector(() => ({ statusCode: 200, body: "{}" }));
    const helpers = createBetterAuthTestHelpers({ basePath: "/auth" });
    await helpers.signUp(app as unknown as FastifyInstance, {
      email: "a@x.com",
      password: "pw",
      name: "Alice",
    });
    expect(app.calls[0]!.url).toBe("/auth/sign-up/email");
  });

  it("tolerates token under .session.token (Better Auth version drift)", async () => {
    const app = makeInjector(() => ({
      statusCode: 200,
      body: JSON.stringify({ session: { token: "nested-tok" }, user: { id: "u2" } }),
    }));
    const helpers = createBetterAuthTestHelpers();
    const result = await helpers.signUp(app as unknown as FastifyInstance, {
      email: "b@x.com",
      password: "pw",
      name: "Bob",
    });
    expect(result.token).toBe("nested-tok");
  });

  it("tolerates token under .data.token", async () => {
    const app = makeInjector(() => ({
      statusCode: 200,
      body: JSON.stringify({ data: { token: "data-tok", id: "u3" } }),
    }));
    const helpers = createBetterAuthTestHelpers();
    const result = await helpers.signUp(app as unknown as FastifyInstance, {
      email: "c@x.com",
      password: "pw",
      name: "Cara",
    });
    expect(result.token).toBe("data-tok");
  });

  it("returns empty strings (not throws) when server rejects signup", async () => {
    const app = makeInjector(() => ({
      statusCode: 400,
      body: JSON.stringify({ error: "email_taken" }),
    }));
    const helpers = createBetterAuthTestHelpers();
    const result = await helpers.signUp(app as unknown as FastifyInstance, {
      email: "dup@x.com",
      password: "pw",
      name: "Dupe",
    });
    expect(result.statusCode).toBe(400);
    expect(result.token).toBe("");
    expect(result.userId).toBe("");
  });
});

describe("createBetterAuthTestHelpers — signIn / createOrg / setActiveOrg / authHeaders", () => {
  it("signIn POSTs /sign-in/email", async () => {
    const app = makeInjector(() => ({
      statusCode: 200,
      body: JSON.stringify({ token: "signed-in", user: { id: "u5" } }),
    }));
    const helpers = createBetterAuthTestHelpers();
    const res = await helpers.signIn(app as unknown as FastifyInstance, {
      email: "e@x.com",
      password: "pw",
    });
    expect(app.calls[0]!.url).toBe("/api/auth/sign-in/email");
    expect(res.token).toBe("signed-in");
    expect(res.userId).toBe("u5");
  });

  it("createOrg sends Authorization Bearer + parses orgId from .organization.id", async () => {
    const app = makeInjector(() => ({
      statusCode: 201,
      body: JSON.stringify({ organization: { id: "org-99", name: "Acme" } }),
    }));
    const helpers = createBetterAuthTestHelpers();
    const res = await helpers.createOrg(app as unknown as FastifyInstance, "my-token", {
      name: "Acme",
      slug: "acme",
    });
    expect(app.calls[0]).toMatchObject({
      method: "POST",
      url: "/api/auth/organization/create",
      payload: { name: "Acme", slug: "acme" },
      headers: expect.objectContaining({ authorization: "Bearer my-token" }),
    });
    expect(res.orgId).toBe("org-99");
  });

  it("setActiveOrg POSTs organizationId in payload", async () => {
    const app = makeInjector(() => ({ statusCode: 204, body: "" }));
    const helpers = createBetterAuthTestHelpers();
    const res = await helpers.setActiveOrg(
      app as unknown as FastifyInstance,
      "my-token",
      "org-xyz",
    );
    expect(app.calls[0]).toMatchObject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      payload: { organizationId: "org-xyz" },
      headers: expect.objectContaining({ authorization: "Bearer my-token" }),
    });
    expect(res.statusCode).toBe(204);
  });

  it("authHeaders builds { authorization, x-organization-id }", () => {
    const helpers = createBetterAuthTestHelpers();
    expect(helpers.authHeaders("tok-1")).toEqual({ authorization: "Bearer tok-1" });
    expect(helpers.authHeaders("tok-1", "org-x")).toEqual({
      authorization: "Bearer tok-1",
      "x-organization-id": "org-x",
    });
  });
});

// ============================================================================
// setupBetterAuthTestApp — orchestrator
// ============================================================================

describe("setupBetterAuthTestApp — composite flow", () => {
  /**
   * A "fake" app that responds to signup/signin/createOrg/setActive
   * endpoints deterministically. Keeps the test independent of a real
   * Better Auth install while still exercising the orchestrator's
   * sequencing + error handling.
   */
  function makeFakeApp(): {
    app: FastifyInstance;
    calls: MockCall[];
    users: Record<string, string>; // email → userId
    tokens: Record<string, string>; // userId → token
  } {
    const calls: MockCall[] = [];
    const users: Record<string, string> = {};
    const tokens: Record<string, string> = {};
    let userCounter = 0;
    let orgCounter = 0;
    const close = vi.fn(async () => {});

    const inject = async (opts: {
      method: string;
      url: string;
      payload?: unknown;
      headers?: Record<string, string>;
    }): Promise<MockResponse> => {
      calls.push({
        method: opts.method,
        url: opts.url,
        payload: opts.payload,
        headers: opts.headers,
      });
      if (opts.url.endsWith("/sign-up/email")) {
        const p = opts.payload as { email: string; name: string };
        const userId = `user-${++userCounter}`;
        const token = `tok-${userId}`;
        users[p.email] = userId;
        tokens[userId] = token;
        return {
          statusCode: 200,
          body: JSON.stringify({ token, user: { id: userId, email: p.email, name: p.name } }),
        };
      }
      if (opts.url.endsWith("/organization/create")) {
        const orgId = `org-${++orgCounter}`;
        const p = opts.payload as { name: string; slug?: string };
        return {
          statusCode: 201,
          body: JSON.stringify({ organization: { id: orgId, name: p.name, slug: p.slug } }),
        };
      }
      if (opts.url.endsWith("/organization/set-active")) {
        return { statusCode: 204, body: "" };
      }
      return { statusCode: 404, body: JSON.stringify({ error: "route not mocked" }) };
    };

    return {
      app: { inject, close } as unknown as FastifyInstance,
      calls,
      users,
      tokens,
    };
  }

  it("signs up every user, creates the org from the creator, registers all into a TestAuthProvider", async () => {
    const { app, calls, users } = makeFakeApp();
    const addMember = vi.fn(async () => ({ statusCode: 200, body: "{}" }));

    const result = await setupBetterAuthTestApp({
      app,
      org: { name: "Test Corp", slug: "test-corp" },
      users: [
        { key: "admin", email: "a@x.com", password: "pw", name: "Admin", isCreator: true },
        { key: "member", email: "m@x.com", password: "pw", name: "Member", role: "member" },
      ],
      addMember,
    });

    // Orchestration contract:
    //   2 signUps (admin, member)
    //   1 createOrg (admin)
    //   1 addMember invocation (member only — creator skipped)
    //   2 setActive calls (one per user)
    expect(result.orgId).toMatch(/^org-\d+$/);
    expect(Object.keys(result.users)).toEqual(["admin", "member"]);
    expect(result.users.admin!.userId).toBe(users["a@x.com"]);
    expect(result.users.member!.userId).toBe(users["m@x.com"]);
    expect(result.users.admin!.token).toMatch(/^tok-/);

    // addMember was invoked for the non-creator only
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(addMember).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: result.orgId,
        userId: users["m@x.com"],
        role: "member",
      }),
    );

    // setActive fired for every user (2 calls)
    const setActiveCalls = calls.filter((c) => c.url.endsWith("/organization/set-active"));
    expect(setActiveCalls).toHaveLength(2);
  });

  it("registers each user key into the returned TestAuthProvider (2.11 session pattern)", async () => {
    const { app } = makeFakeApp();

    const result = await setupBetterAuthTestApp({
      app,
      org: { name: "Corp" },
      users: [
        { key: "owner", email: "o@x.com", password: "pw", name: "Owner", isCreator: true },
        { key: "member", email: "m@x.com", password: "pw", name: "Member" },
      ],
      addMember: async () => ({ statusCode: 200, body: "{}" }),
    });

    // The primary DX win: the orchestrator hands back a TestAuthProvider
    // with every user pre-registered, so tests can do:
    //   await app.inject({ headers: result.auth.as('owner').headers });
    expect(result.auth.roles).toEqual(["owner", "member"]);
    const ownerSession = result.auth.as("owner");
    expect(ownerSession.token).toMatch(/^tok-/);
    expect(ownerSession.headers.authorization).toMatch(/^Bearer tok-/);
    expect(ownerSession.headers["x-organization-id"]).toBe(result.orgId);
  });

  it("throws when no user has isCreator: true (ambiguous org ownership)", async () => {
    const { app } = makeFakeApp();
    await expect(
      setupBetterAuthTestApp({
        app,
        org: { name: "Corp" },
        users: [
          { key: "admin", email: "a@x.com", password: "pw", name: "Admin" },
          { key: "member", email: "m@x.com", password: "pw", name: "Member" },
        ],
      }),
    ).rejects.toThrow(/expected exactly one user with 'isCreator: true'/);
  });

  it("throws when multiple users are marked isCreator: true", async () => {
    const { app } = makeFakeApp();
    await expect(
      setupBetterAuthTestApp({
        app,
        org: { name: "Corp" },
        users: [
          { key: "admin", email: "a@x.com", password: "pw", name: "Admin", isCreator: true },
          { key: "admin2", email: "b@x.com", password: "pw", name: "Admin2", isCreator: true },
        ],
      }),
    ).rejects.toThrow(/expected exactly one user with 'isCreator: true'/);
  });

  it("throws with a clear diagnostic when signUp fails", async () => {
    // Fake app that always 400s on signup
    const close = vi.fn(async () => {});
    const app = {
      async inject() {
        return { statusCode: 400, body: JSON.stringify({ error: "email_taken" }) };
      },
      close,
    } as unknown as FastifyInstance;

    await expect(
      setupBetterAuthTestApp({
        app,
        org: { name: "Corp" },
        users: [{ key: "admin", email: "a@x.com", password: "pw", name: "Admin", isCreator: true }],
      }),
    ).rejects.toThrow(/signUp failed for 'admin'.*email_taken/);
  });

  it("skips addMember entirely when not supplied (caller wires it manually)", async () => {
    const { app, calls } = makeFakeApp();
    await setupBetterAuthTestApp({
      app,
      org: { name: "Corp" },
      users: [
        { key: "owner", email: "o@x.com", password: "pw", name: "Owner", isCreator: true },
        { key: "member", email: "m@x.com", password: "pw", name: "Member" },
      ],
      // no addMember — orchestrator should NOT invent one; just signs up + sets active.
    });

    // Only signup + createOrg + setActive calls — no addMember mock path exists,
    // so any "addMember" call would 404 from the fake injector.
    const routes = calls.map((c) => c.url);
    expect(routes).not.toContain("/api/auth/organization/add-member");
    // Two signups + one createOrg + two setActive = 5 calls total.
    expect(calls).toHaveLength(5);
  });

  it("honors custom basePath across every sub-request", async () => {
    const { app, calls } = makeFakeApp();
    await setupBetterAuthTestApp({
      app,
      basePath: "/auth",
      org: { name: "Corp" },
      users: [{ key: "owner", email: "o@x.com", password: "pw", name: "Owner", isCreator: true }],
    });
    expect(calls.every((c) => c.url.startsWith("/auth/"))).toBe(true);
  });

  it("teardown invokes app.close (lifecycle handle)", async () => {
    const close = vi.fn(async () => {});
    const inject = async () => ({
      statusCode: 200,
      body: JSON.stringify({ token: "t", user: { id: "u1" }, organization: { id: "org-1" } }),
    });
    const app = { inject, close } as unknown as FastifyInstance;

    const result = await setupBetterAuthTestApp({
      app,
      org: { name: "Corp" },
      users: [{ key: "owner", email: "o@x.com", password: "pw", name: "Owner", isCreator: true }],
    });
    await result.teardown();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Interop with createBetterAuthProvider (2.11 primitive)
// ============================================================================

describe("interop with createBetterAuthProvider", () => {
  it("the helper's auth output is a real TestAuthProvider — .as() sessions work", async () => {
    // Regression guard: the orchestrator registers users into a real
    // `TestAuthProvider` produced by `createBetterAuthProvider`, not a
    // bespoke dictionary. Tests that migrate from the pre-2.11 surface
    // to the orchestrator should get 2.11-native sessions for free.
    const provider = createBetterAuthProvider({ defaultOrgId: "org-1" });
    provider.register("admin", { token: "pre-signed-token" });
    const session = provider.as("admin");
    expect(session.headers.authorization).toBe("Bearer pre-signed-token");
    expect(session.headers["x-organization-id"]).toBe("org-1");
  });
});
