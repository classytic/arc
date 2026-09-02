/**
 * CONTRACT test against the REAL `better-auth` package — no mock handler.
 *
 * Every other org test in this suite drives a hand-written double, so none of
 * them can observe what Better Auth actually does. Two defects got through that
 * blind spot:
 *
 *   - a fixture answered to `listTeams`, a name BA never registers server-side,
 *     so the team tests exercised a dead fallback and passed;
 *   - the peer floor allowed a BA version that stripped `query.organizationId`,
 *     which is the parameter the whole bearer-only org path depends on.
 *
 * A double cannot catch either. These tests pin the two facts arc's org
 * resolution is built on, read from the package that is installed:
 *
 *   1. `getActiveMember` takes NO organizationId — it reads only
 *      `session.activeOrganizationId` and throws without one. That is why
 *      `authenticate` must not call it for a bearer-only session.
 *   2. `getActiveMemberRole` DOES honour `query.organizationId`, which is the
 *      only mechanism that resolves org scope when nothing called `setActive`.
 *
 * If a future BA drops (2), arc loses org scope on every bearer request and the
 * mocked suites stay green. This file is what goes red.
 */

import { memoryAdapter } from "better-auth/adapters/memory";
import { betterAuth } from "better-auth";
import { bearer, organization } from "better-auth/plugins";
import { beforeAll, describe, expect, it } from "vitest";

type Db = Record<string, unknown[]>;

let auth: ReturnType<typeof betterAuth>;
let headers: Headers;
let orgId: string;

beforeAll(async () => {
  const db: Db = { user: [], session: [], account: [], verification: [], organization: [], member: [], invitation: [], team: [], teamMember: [] };

  auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-at-least-32-characters-long!!",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    // Teams ON so the endpoint-name assertion below is meaningful; with teams
    // off, `listUserTeams` is simply absent and the check proves nothing.
    plugins: [organization({ teams: { enabled: true } }), bearer()],
  });

  await auth.api.signUpEmail({
    body: { email: "member@example.com", password: "password-1234", name: "Member" },
  });
  const signIn = await auth.api.signInEmail({
    body: { email: "member@example.com", password: "password-1234" },
    asResponse: false,
  });
  const token = (signIn as { token?: string }).token;
  expect(token, "sign-in must mint a bearer token").toBeTruthy();
  headers = new Headers({ authorization: `Bearer ${token}` });

  const org = await auth.api.createOrganization({
    body: { name: "Branch One", slug: "branch-one" },
    headers,
  });
  orgId = (org as { id: string }).id;
  expect(orgId).toBeTruthy();

  /**
   * Sign in AGAIN for a session that never activated an organization.
   *
   * `createOrganization` sets `activeOrganizationId` on the session that made
   * the call, so reusing it would test the opposite of the production shape.
   * A bearer client signs in and never calls `setActive` — this second token is
   * that client.
   */
  const fresh = await auth.api.signInEmail({
    body: { email: "member@example.com", password: "password-1234" },
    asResponse: false,
  });
  const freshToken = (fresh as { token?: string }).token;
  expect(freshToken, "second sign-in must mint a token").toBeTruthy();
  headers = new Headers({ authorization: `Bearer ${freshToken}` });
});

describe("better-auth org contract (real package)", () => {
  it("the session has NO activeOrganizationId — the bearer-only shape arc must handle", async () => {
    const session = await auth.api.getSession({ headers });

    expect(session?.user).toBeTruthy();
    // `createOrganization` does not activate; only `setActive` would. This is
    // precisely the state a bearer client is permanently in.
    expect(session?.session.activeOrganizationId ?? null).toBeNull();
  });

  it("getActiveMember THROWS without an active org — it accepts no organizationId", async () => {
    await expect(
      (auth.api as unknown as { getActiveMember: (o: { headers: Headers }) => Promise<unknown> }).getActiveMember({
        headers,
      }),
    ).rejects.toThrow();
  });

  it("getActiveMemberRole HONOURS query.organizationId — the mechanism arc depends on", async () => {
    const result = await (
      auth.api as unknown as {
        getActiveMemberRole: (o: { headers: Headers; query: { organizationId: string } }) => Promise<{ role?: unknown }>;
      }
    ).getActiveMemberRole({ headers, query: { organizationId: orgId } });

    // A creator is the owner of the org they created. The exact role matters
    // less than that a role came back FROM THE QUERY, with no active org set.
    expect(result?.role).toBeTruthy();
    expect(String(result.role)).toContain("owner");
  });

  it("listUserTeams is the registered server name, listTeams is not", () => {
    const api = auth.api as unknown as Record<string, unknown>;

    expect(typeof api.listUserTeams).toBe("function");
    // The client-side name. A fixture offering it silently covers nothing.
    expect(api.listTeams).toBeUndefined();
  });
});
