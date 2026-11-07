/**
 * `socialAuth()` on a real `betterAuth()` (memory adapter, so the handoff record goes through
 * Better Auth's own verification store) with the Google provider's code exchange stubbed.
 * Covers the callback `#handoff` fragment, the exchange, every refusal, and the provider list.
 */

import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSocialProviders, socialAuth } from "../../../src/auth/social/index.js";

const API = "http://localhost:4000";
const APP = "http://localhost:3000";
const EMAIL = "ada@example.com";

function createAuth(advanced: { disableOriginCheck?: boolean } = {}) {
  const social = defineSocialProviders({
    enabled: "google",
    env: { GOOGLE_CLIENT_ID: "web-client", GOOGLE_CLIENT_SECRET: "web-secret" },
  });
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: API,
    secret: "social-handoff-test-secret-0123456789",
    trustedOrigins: [APP, ...social.trustedOrigins],
    emailAndPassword: { enabled: true, autoSignIn: true },
    advanced,
    socialProviders: {
      ...social.socialProviders,
      github: { clientId: "gh", clientSecret: "gh", enabled: false },
    },
    plugins: [socialAuth({ providers: social.providers }), bearer()],
  });
}
type Auth = ReturnType<typeof createAuth>;

/** Replace Google's network calls: any code exchanges for a fixed, verified identity. */
async function stubGoogle(auth: Auth) {
  const ctx = await auth.$context;
  const google = ctx.socialProviders.find((p) => p.id === "google") as unknown as Record<
    string,
    unknown
  >;
  google.validateAuthorizationCode = async () => ({ accessToken: "at", idToken: "id" });
  google.getUserInfo = async () => ({
    user: { email: EMAIL, name: "Ada", emailVerified: true },
    data: { sub: "google-sub-1", email: EMAIL, email_verified: true },
  });
}

async function call(
  auth: Auth,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers({ origin: APP });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return auth.handler(
    new Request(`${API}/api/auth${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

const cookiesOf = (res: Response, prior = ""): string =>
  [prior, ...res.headers.getSetCookie().map((c) => c.split(";")[0])].filter(Boolean).join("; ");

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Start a redirect flow at `startPath` and complete Google's callback; the callback Location. */
async function completeFlow(
  auth: Auth,
  body: Record<string, unknown>,
  startPath = "/sign-in/social",
  sessionCookie = "",
): Promise<string> {
  const start = await call(auth, "POST", startPath, {
    body: { provider: "google", ...body },
    cookie: sessionCookie,
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  const callback = await call(auth, "GET", `/callback/google?code=provider-code&state=${state}`, {
    cookie: cookiesOf(start, sessionCookie),
  });
  expect(callback.status).toBe(302);
  return callback.headers.get("location") ?? "";
}

const handoffCode = (location: string) => new URL(location).hash.match(/handoff=([^&]+)/)?.[1];

afterEach(() => {
  vi.useRealTimers();
});

describe("social sign-in handoff", () => {
  it("a new session redirecting to a trusted origin carries #handoff; the exchange returns the session", async () => {
    const auth = createAuth();
    await stubGoogle(auth);
    const { verifier, challenge } = pkce();

    const location = await completeFlow(auth, {
      callbackURL: `${APP}/done?next=%2Fcourses&new=1#tab=1`,
      additionalData: { handoff: challenge },
    });
    expect(location).toMatch(
      /^http:\/\/localhost:3000\/done\?next=%2Fcourses&new=1#tab=1&handoff=/,
    );
    const code = handoffCode(location);

    const res = await call(auth, "POST", "/social/handoff", { body: { code, verifier } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { email: string } };
    expect(body.user.email).toBe(EMAIL);
    expect(res.headers.get("set-auth-token")).toMatch(new RegExp(`^${body.token}\\.`));

    // The bearer token is a working session.
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${res.headers.get("set-auth-token")}` }),
    });
    expect(session?.user.email).toBe(EMAIL);
  });

  it("a code works once: replay, wrong verifier and expiry all answer 400 HANDOFF_INVALID", async () => {
    const auth = createAuth();
    await stubGoogle(auth);
    const flow = async () => {
      const keys = pkce();
      const location = await completeFlow(auth, {
        callbackURL: `${APP}/done`,
        additionalData: { handoff: keys.challenge },
      });
      return { ...keys, code: handoffCode(location) };
    };
    const refused = async (res: Response) => {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "HANDOFF_INVALID" });
    };

    const first = await flow();
    expect((await call(auth, "POST", "/social/handoff", { body: first })).status).toBe(200);
    await refused(await call(auth, "POST", "/social/handoff", { body: first }));

    const second = await flow();
    await refused(
      await call(auth, "POST", "/social/handoff", {
        body: { ...second, verifier: pkce().verifier },
      }),
    );
    // The wrong guess consumed it.
    await refused(await call(auth, "POST", "/social/handoff", { body: second }));

    vi.useFakeTimers({ toFake: ["Date"] });
    const third = await flow();
    vi.setSystemTime(Date.now() + 61_000);
    await refused(await call(auth, "POST", "/social/handoff", { body: third }));

    await refused(
      await call(auth, "POST", "/social/handoff", { body: { code: "x", verifier: "y" } }),
    );
  });

  it("no code without a requested handoff, or for an untrusted callback origin", async () => {
    const plain = createAuth();
    await stubGoogle(plain);
    expect(await completeFlow(plain, { callbackURL: `${APP}/done` })).toBe(`${APP}/done`);

    // A callbackURL that got past sign-in validation still gets no code.
    const lax = createAuth({ disableOriginCheck: true });
    await stubGoogle(lax);
    const location = await completeFlow(lax, {
      callbackURL: "https://evil.example/landing",
      additionalData: { handoff: pkce().challenge },
    });
    expect(location).toBe("https://evil.example/landing");
  });

  it("a linking callback (no new session) gets no code", async () => {
    const auth = createAuth();
    await stubGoogle(auth);
    const signUp = await call(auth, "POST", "/sign-up/email", {
      body: { email: EMAIL, password: "supersecure-password-123", name: "Ada" },
    });
    expect(signUp.status).toBe(200);

    const location = await completeFlow(
      auth,
      { callbackURL: `${APP}/settings`, additionalData: { handoff: pkce().challenge } },
      "/link-social",
      cookiesOf(signUp),
    );
    expect(location).toBe(`${APP}/settings`);
  });
});

describe("GET /social/providers", () => {
  it("lists only enabled providers, cacheable for five minutes", async () => {
    const res = await call(createAuth(), "GET", "/social/providers");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({ providers: [{ id: "google", name: "Google" }] });
  });
});
