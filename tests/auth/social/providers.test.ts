/**
 * `defineSocialProviders`: env → Better Auth `socialProviders`, explicit enabling, named missing
 * variables, Google defaults, and the Google `getUserInfo` that verifies the id token.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSocialProviders } from "../../../src/auth/social/index.js";
import { stubGoogleJwks } from "./google-jwks.js";

const GOOGLE_ENV = { GOOGLE_CLIENT_ID: "web-client", GOOGLE_CLIENT_SECRET: "web-secret" };

type GoogleConfig = Record<string, unknown> & {
  getUserInfo: (token: { idToken?: string }) => Promise<{
    user: Record<string, unknown>;
    data: Record<string, unknown>;
  } | null>;
};
const googleOf = (result: ReturnType<typeof defineSocialProviders>) =>
  result.socialProviders.google as unknown as GoogleConfig;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defineSocialProviders", () => {
  it("builds the enabled providers from env, in order, with display names", () => {
    const result = defineSocialProviders({
      enabled: " github , google ",
      env: { ...GOOGLE_ENV, GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" },
    });
    expect(Object.keys(result.socialProviders)).toEqual(["github", "google"]);
    expect(result.socialProviders.github).toEqual({ clientId: "gh-id", clientSecret: "gh-secret" });
    expect(result.providers).toEqual([
      { id: "github", name: "GitHub" },
      { id: "google", name: "Google" },
    ]);
    expect(result.trustedOrigins).toEqual([]);
  });

  it("enables only what `enabled` names: credentials alone enable nothing", () => {
    const env = { ...GOOGLE_ENV, GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" };
    expect(
      Object.keys(defineSocialProviders({ enabled: ["google"], env }).socialProviders),
    ).toEqual(["google"]);
    expect(defineSocialProviders({ enabled: "", env }).socialProviders).toEqual({});
  });

  it("names every missing variable of every enabled provider", () => {
    expect(() =>
      defineSocialProviders({
        enabled: ["google", "apple"],
        env: { GOOGLE_CLIENT_ID: "web-client", GOOGLE_CLIENT_SECRET: "  " },
      }),
    ).toThrow(
      'defineSocialProviders: enabled provider is missing credentials: "google" needs GOOGLE_CLIENT_SECRET; "apple" needs APPLE_CLIENT_ID, APPLE_CLIENT_SECRET.',
    );
  });

  it("refuses an id it has no preset for", () => {
    expect(() => defineSocialProviders({ enabled: "google,myspace", env: GOOGLE_ENV })).toThrow(
      'unknown provider "myspace"',
    );
  });

  it("Google: openid email profile only, account chooser, no offline access", () => {
    const google = googleOf(defineSocialProviders({ enabled: "google", env: GOOGLE_ENV }));
    expect(google).toMatchObject({
      clientId: "web-client",
      clientSecret: "web-secret",
      disableDefaultScope: true,
      scope: ["openid", "email", "profile"],
      includeGrantedScopes: false,
      prompt: "select_account",
      accessType: "online",
    });
  });

  it("Google: GOOGLE_ID_TOKEN_AUDIENCES join the web client id as accepted audiences", () => {
    const google = googleOf(
      defineSocialProviders({
        enabled: "google",
        env: { ...GOOGLE_ENV, GOOGLE_ID_TOKEN_AUDIENCES: "ios-client, android-client" },
      }),
    );
    expect(google.clientId).toEqual(["web-client", "ios-client", "android-client"]);
  });

  it("Apple: adds appleid.apple.com to the trusted origins and the optional bundle id", () => {
    const result = defineSocialProviders({
      enabled: "apple",
      env: {
        APPLE_CLIENT_ID: "svc",
        APPLE_CLIENT_SECRET: "jwt",
        APPLE_APP_BUNDLE_IDENTIFIER: "com.example.app",
      },
    });
    expect(result.trustedOrigins).toEqual(["https://appleid.apple.com"]);
    expect(result.socialProviders.apple).toMatchObject({ appBundleIdentifier: "com.example.app" });
  });

  it("overrides merge over the preset", () => {
    const google = googleOf(
      defineSocialProviders({
        enabled: "google",
        env: GOOGLE_ENV,
        overrides: { google: { prompt: "consent", hd: "example.com" } },
      }),
    );
    expect(google).toMatchObject({ prompt: "consent", hd: "example.com", clientId: "web-client" });
  });
});

describe("Google getUserInfo verifies the id token", () => {
  const setup = async (env: Record<string, string> = GOOGLE_ENV, hd?: string) => {
    const { mint } = await stubGoogleJwks();
    const google = googleOf(
      defineSocialProviders({
        enabled: "google",
        env,
        ...(hd ? { overrides: { google: { hd } } } : {}),
      }),
    );
    return { mint, google };
  };

  it("maps a valid token, emailVerified only on email_verified === true", async () => {
    const { mint, google } = await setup();
    const info = await google.getUserInfo({ idToken: await mint({ aud: "web-client" }) });
    expect(info?.user).toMatchObject({
      email: "ada@example.com",
      name: "Ada Lovelace",
      image: "https://example.com/ada.png",
      emailVerified: true,
    });
    expect(info?.data.sub).toBe("google-sub-1");

    const unverified = await google.getUserInfo({
      idToken: await mint({
        aud: "web-client",
        email_verified: "true",
        name: "",
        given_name: "Ada",
        family_name: "L",
      }),
    });
    expect(unverified?.user).toMatchObject({ emailVerified: false, name: "Ada L" });
  });

  it("refuses a token minted for another client", async () => {
    const { mint, google } = await setup();
    expect(await google.getUserInfo({ idToken: await mint({ aud: "someone-else" }) })).toBeNull();
  });

  it("refuses an expired token", async () => {
    const { mint, google } = await setup();
    const expired = await mint({ aud: "web-client" }, "-1m");
    expect(await google.getUserInfo({ idToken: expired })).toBeNull();
  });

  it("accepts a native audience from GOOGLE_ID_TOKEN_AUDIENCES", async () => {
    const { mint, google } = await setup({
      ...GOOGLE_ENV,
      GOOGLE_ID_TOKEN_AUDIENCES: "ios-client",
    });
    expect(await google.getUserInfo({ idToken: await mint({ aud: "ios-client" }) })).not.toBeNull();
  });

  it("keeps the hosted-domain (hd) check", async () => {
    const { mint, google } = await setup(GOOGLE_ENV, "example.com");
    expect(
      await google.getUserInfo({ idToken: await mint({ aud: "web-client", hd: "other.com" }) }),
    ).toBeNull();
    expect(
      await google.getUserInfo({ idToken: await mint({ aud: "web-client", hd: "example.com" }) }),
    ).not.toBeNull();
  });
});
