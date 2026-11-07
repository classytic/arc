/**
 * Better Auth's `/one-tap/callback` drops a client `nonce`; `socialAuth()` enforces it. Real
 * `betterAuth()` with `oneTap()`, Google's JWKS served locally.
 */

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { oneTap } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSocialProviders, socialAuth } from "../../../src/auth/social/index.js";
import { stubGoogleJwks } from "./google-jwks.js";

const API = "http://localhost:4000";

function createAuth() {
  const social = defineSocialProviders({
    enabled: "google",
    env: { GOOGLE_CLIENT_ID: "web-client", GOOGLE_CLIENT_SECRET: "web-secret" },
  });
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: API,
    secret: "social-one-tap-test-secret-0123456789",
    socialProviders: social.socialProviders,
    plugins: [socialAuth({ providers: social.providers }), oneTap()],
  });
}

const oneTapCall = (auth: ReturnType<typeof createAuth>, body: Record<string, unknown>) =>
  auth.handler(
    new Request(`${API}/api/auth/one-tap/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: API },
      body: JSON.stringify(body),
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("One Tap nonce", () => {
  it("a sent nonce must match the token's; without one Better Auth's own checks apply", async () => {
    const { mint } = await stubGoogleJwks();
    const auth = createAuth();

    const bound = await mint({ aud: "web-client", nonce: "n-1" });
    expect((await oneTapCall(auth, { idToken: bound, nonce: "n-1" })).status).toBe(200);

    const mismatch = await oneTapCall(auth, { idToken: bound, nonce: "n-2" });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: "ONE_TAP_NONCE_MISMATCH" });

    const unbound = await mint({ aud: "web-client" });
    expect((await oneTapCall(auth, { idToken: unbound, nonce: "n-1" })).status).toBe(400);
    expect((await oneTapCall(auth, { idToken: unbound })).status).toBe(200);
  });
});
