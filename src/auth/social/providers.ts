/**
 * Social provider presets for Better Auth, built from environment variables.
 *
 * Enabling is explicit: a provider is configured only when `enabled` names it, and an enabled
 * provider with missing credentials throws, naming every missing variable. Credentials alone
 * never enable a provider.
 *
 * Google's own provider only DECODES the id token returned by the code exchange; the preset
 * replaces `getUserInfo` with one that verifies signature, issuer, audience and expiry through
 * Better Auth's `verifyGoogleIdToken` before mapping, and keeps the `hd` hosted-domain check.
 */

import type { OAuth2Tokens } from "better-auth";
import type { GoogleProfile, SocialProviders } from "better-auth/social-providers";
import { isGoogleHostedDomainAllowed, verifyGoogleIdToken } from "better-auth/social-providers";

/** Provider ids with a preset. */
export type SocialProviderId = "google" | "github" | "apple" | "facebook";

/** A provider as listed to clients: id plus display name. */
export interface SocialProviderInfo {
  id: string;
  name: string;
}

export interface DefineSocialProvidersOptions {
  /** Providers to enable: an array or a comma list (`"google,github"`). Empty enables none. */
  enabled: readonly string[] | string;
  /** Where credentials are read. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Better Auth provider options merged over each preset (shallow). */
  overrides?: Partial<Record<SocialProviderId, Record<string, unknown>>>;
}

export interface DefinedSocialProviders {
  /** Pass to `betterAuth({ socialProviders })`. */
  socialProviders: SocialProviders;
  /** Enabled providers in `enabled` order; pass to `socialAuth({ providers })`. */
  providers: SocialProviderInfo[];
  /** Origins the enabled providers post back from (Apple's form_post). Add to `trustedOrigins`. */
  trustedOrigins: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

interface Preset {
  name: string;
  /** Required variables, in the order an error names them. */
  required: readonly string[];
  trustedOrigins?: readonly string[];
  build(env: Env): Record<string, unknown>;
}

/** Comma list from an env value, trimmed, empties dropped. */
function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** An env value, trimmed; `undefined` when unset or blank. */
function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/** Google profile → Better Auth user fields. `emailVerified` only on a literal `true`. */
function mapGoogleProfile(profile: GoogleProfile): {
  name: string;
  image: string | undefined;
  emailVerified: boolean;
} {
  const joined = [profile.given_name, profile.family_name].filter(Boolean).join(" ");
  return {
    name: profile.name || joined,
    image: profile.picture || undefined,
    emailVerified: profile.email_verified === true,
  };
}

type GoogleUserInfo = {
  user: { email: string; name: string; image?: string; emailVerified: boolean } & Record<
    string,
    unknown
  >;
  data: GoogleProfile;
};

type ProfileMapper = (profile: GoogleProfile) => unknown;

/**
 * Google `getUserInfo` that verifies the id token (signature against Google's JWKS, issuer,
 * audience = every configured client id, expiry, max age 1h, nonce when the flow bound one)
 * before mapping. `null` (sign-in refused) on any failure, as Better Auth's own providers do.
 */
async function verifiedGoogleUserInfo(
  token: OAuth2Tokens & { expectedIdTokenNonce?: string },
  config: { clientId: string | string[]; hd?: string; mapProfileToUser?: ProfileMapper },
): Promise<GoogleUserInfo | null> {
  if (!token.idToken) return null;
  const payload = await verifyGoogleIdToken({
    token: token.idToken,
    audience: config.clientId,
    nonce: token.expectedIdTokenNonce,
  });
  if (!payload || typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
  if (!isGoogleHostedDomainAllowed(config.hd, payload.hd)) return null;
  const profile = payload as unknown as GoogleProfile;
  const mapped = (await config.mapProfileToUser?.(profile)) as Record<string, unknown> | undefined;
  return {
    user: { email: profile.email, ...mapGoogleProfile(profile), ...mapped },
    data: profile,
  };
}

const PRESETS: Record<SocialProviderId, Preset> = {
  google: {
    name: "Google",
    required: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    build: (env) => {
      const audiences = list(read(env, "GOOGLE_ID_TOKEN_AUDIENCES"));
      const clientId = read(env, "GOOGLE_CLIENT_ID") as string;
      return {
        // The first entry is the web client the redirect flow uses; the rest are native/mobile
        // audiences accepted on `signIn.social({ idToken })`.
        clientId: audiences.length > 0 ? [clientId, ...audiences] : clientId,
        clientSecret: read(env, "GOOGLE_CLIENT_SECRET"),
        disableDefaultScope: true,
        scope: ["openid", "email", "profile"],
        includeGrantedScopes: false,
        prompt: "select_account",
        accessType: "online",
        mapProfileToUser: mapGoogleProfile,
      };
    },
  },
  github: {
    name: "GitHub",
    required: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    build: (env) => ({
      clientId: read(env, "GITHUB_CLIENT_ID"),
      clientSecret: read(env, "GITHUB_CLIENT_SECRET"),
    }),
  },
  apple: {
    name: "Apple",
    required: ["APPLE_CLIENT_ID", "APPLE_CLIENT_SECRET"],
    trustedOrigins: ["https://appleid.apple.com"],
    build: (env) => {
      const bundle = read(env, "APPLE_APP_BUNDLE_IDENTIFIER");
      return {
        clientId: read(env, "APPLE_CLIENT_ID"),
        clientSecret: read(env, "APPLE_CLIENT_SECRET"),
        ...(bundle ? { appBundleIdentifier: bundle } : {}),
      };
    },
  },
  facebook: {
    name: "Facebook",
    required: ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"],
    build: (env) => ({
      clientId: read(env, "FACEBOOK_CLIENT_ID"),
      clientSecret: read(env, "FACEBOOK_CLIENT_SECRET"),
    }),
  },
};

/** Display name of a preset provider, or `undefined` for an id arc has no preset for. */
export function socialProviderName(id: string): string | undefined {
  return Object.hasOwn(PRESETS, id) ? PRESETS[id as SocialProviderId].name : undefined;
}

/**
 * Better Auth `socialProviders`, the client-facing provider list and the extra trusted origins,
 * for the providers `enabled` names. Throws on an unknown id, and on an enabled provider whose
 * credentials are missing (the message names each missing variable).
 *
 * @example
 * const social = defineSocialProviders({ enabled: process.env.SOCIAL_PROVIDERS ?? "" });
 * betterAuth({ socialProviders: social.socialProviders, plugins: [socialAuth({ providers: social.providers })] });
 */
export function defineSocialProviders(
  options: DefineSocialProvidersOptions,
): DefinedSocialProviders {
  const env = options.env ?? process.env;
  const ids = [
    ...new Set(typeof options.enabled === "string" ? list(options.enabled) : options.enabled),
  ];

  const unknown = ids.filter((id) => !Object.hasOwn(PRESETS, id));
  if (unknown.length > 0)
    throw new Error(
      `defineSocialProviders: unknown provider ${unknown.map((id) => `"${id}"`).join(", ")}. ` +
        `Presets: ${Object.keys(PRESETS).join(", ")}. Configure others in betterAuth({ socialProviders }) directly.`,
    );

  const missing = ids.flatMap((id) => {
    const absent = PRESETS[id as SocialProviderId].required.filter((key) => !read(env, key));
    return absent.length > 0 ? [`"${id}" needs ${absent.join(", ")}`] : [];
  });
  if (missing.length > 0)
    throw new Error(
      `defineSocialProviders: enabled provider is missing credentials: ${missing.join("; ")}.`,
    );

  const socialProviders: Record<string, Record<string, unknown>> = {};
  const trustedOrigins = new Set<string>();
  for (const id of ids as SocialProviderId[]) {
    const preset = PRESETS[id];
    const override = options.overrides?.[id];
    const config: Record<string, unknown> = { ...preset.build(env), ...override };
    if (id === "google" && !override?.getUserInfo) {
      config.getUserInfo = (token: OAuth2Tokens & { expectedIdTokenNonce?: string }) =>
        verifiedGoogleUserInfo(
          token,
          config as { clientId: string | string[]; hd?: string; mapProfileToUser?: ProfileMapper },
        );
    }
    socialProviders[id] = config;
    for (const origin of preset.trustedOrigins ?? []) trustedOrigins.add(origin);
  }

  return {
    socialProviders: socialProviders as SocialProviders,
    providers: ids.map((id) => ({ id, name: PRESETS[id as SocialProviderId].name })),
    trustedOrigins: [...trustedOrigins],
  };
}
