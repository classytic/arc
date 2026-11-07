/**
 * `socialAuth()`: a Better Auth plugin that serves social sign-in under the auth catch-all.
 *
 * - `GET /social/providers`: the enabled providers, `{ providers: [{ id, name }] }`.
 * - OAuth bearer handoff: a client that cannot rely on the API's cookie starts
 *   `signIn.social({ additionalData: { handoff: challenge } })` with challenge =
 *   base64url(SHA-256(verifier)). When the callback creates a NEW session and redirects to an
 *   absolute trusted URL, an after hook stores a single-use record (60 s, keyed by a hash of a
 *   random code, through Better Auth's verification store, so any database adapter works) and
 *   appends `#handoff=<code>` to the redirect. `POST /social/handoff { code, verifier }` consumes
 *   it and returns `{ token, user }` (plus `set-auth-token` when `bearer()` is installed).
 *   Every refusal is the same 400 `HANDOFF_INVALID`.
 * - One Tap nonce: Better Auth's `/one-tap/callback` ignores a client `nonce`; when one is sent,
 *   a before hook verifies the id token with it and refuses a mismatch (400 `ONE_TAP_NONCE_MISMATCH`).
 *
 * Ordering: list `socialAuth()` BEFORE any plugin that strips the session Set-Cookie or rewrites
 * the callback redirect; Better Auth runs plugin hooks in `plugins` order.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import { parseUserOutput } from "better-auth/db";
import { verifyGoogleIdToken } from "better-auth/social-providers";
import { type SocialProviderInfo, socialProviderName } from "./providers.js";

export interface SocialAuthOptions {
  /** Display names for `/social/providers` (`defineSocialProviders().providers`). */
  providers?: readonly SocialProviderInfo[];
}

/** Lifetime of a handoff code. */
const HANDOFF_TTL_MS = 60_000;
/** base64url of 32 bytes (code) or of a SHA-256 digest (challenge). */
const B64URL_256 = /^[A-Za-z0-9_-]{43}$/;
/** PKCE-style verifier: 43 to 128 base64url characters. */
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("base64url");
const handoffIdentifier = (code: string): string => `social-handoff:${sha256(code)}`;

function handoffInvalid(): APIError {
  return new APIError("BAD_REQUEST", {
    code: "HANDOFF_INVALID",
    message: "Invalid or expired handoff code",
  });
}

/** `url` with `handoff=<code>` in its fragment; the query string is untouched. */
function withHandoffFragment(url: string, code: string): string {
  const hash = url.indexOf("#");
  if (hash === -1) return `${url}#handoff=${code}`;
  const fragment = url.slice(hash + 1);
  return fragment ? `${url}&handoff=${code}` : `${url}handoff=${code}`;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Equal-length base64url strings compared in constant time. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Google client ids One Tap tokens may be minted for: the oneTap plugin's, then the provider's. */
function googleAudiences(options: {
  plugins?: Array<{ id: string; options?: unknown }>;
  socialProviders?: unknown;
}): string[] {
  const oneTap = options.plugins?.find((plugin) => plugin.id === "one-tap")?.options as
    | { clientId?: string }
    | undefined;
  const google = (options.socialProviders as { google?: { clientId?: string | string[] } })?.google;
  const ids = [oneTap?.clientId, ...[google?.clientId ?? []].flat()];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function socialAuth(options: SocialAuthOptions = {}): BetterAuthPlugin {
  const names = new Map((options.providers ?? []).map((p) => [p.id, p.name]));

  return {
    id: "social",
    endpoints: {
      listSocialProviders: createAuthEndpoint(
        "/social/providers",
        {
          method: "GET",
          metadata: {
            openapi: {
              summary: "Enabled social sign-in providers",
              responses: { 200: { description: "`{ providers: [{ id, name }] }`" } },
            },
          },
        },
        async (ctx) => {
          // Better Auth resolves `socialProviders` at init and drops `enabled: false` entries.
          const providers = (ctx.context.socialProviders ?? []).map((p) => ({
            id: p.id,
            name: names.get(p.id) ?? socialProviderName(p.id) ?? p.name,
          }));
          ctx.setHeader("Cache-Control", "public, max-age=300");
          return ctx.json({ providers });
        },
      ),

      exchangeSocialHandoff: createAuthEndpoint(
        "/social/handoff",
        {
          method: "POST",
          metadata: {
            openapi: {
              summary: "Exchange an OAuth handoff code for a session token",
              description:
                "Body `{ code, verifier }`. Single use; 400 `HANDOFF_INVALID` on any refusal.",
              responses: {
                200: { description: "`{ token, user }`" },
                400: { description: "`{ code: 'HANDOFF_INVALID' }`" },
              },
            },
          },
        },
        async (ctx) => {
          const body = (ctx.body ?? {}) as { code?: unknown; verifier?: unknown };
          const { code, verifier } = body;
          if (typeof code !== "string" || !B64URL_256.test(code)) throw handoffInvalid();
          if (typeof verifier !== "string" || !VERIFIER.test(verifier)) throw handoffInvalid();

          // Consumed before the verifier check: a wrong guess burns the code.
          const record = await ctx.context.internalAdapter.consumeVerificationValue(
            handoffIdentifier(code),
          );
          if (!record) throw handoffInvalid();
          let stored: { sessionToken?: unknown; challenge?: unknown };
          try {
            stored = JSON.parse(record.value) as typeof stored;
          } catch {
            throw handoffInvalid();
          }
          if (typeof stored.sessionToken !== "string" || typeof stored.challenge !== "string")
            throw handoffInvalid();
          if (!sameDigest(sha256(verifier), stored.challenge)) throw handoffInvalid();

          const found = await ctx.context.internalAdapter.findSession(stored.sessionToken);
          if (!found || new Date(found.session.expiresAt).getTime() <= Date.now())
            throw handoffInvalid();

          const token = found.session.token;
          if (ctx.context.hasPlugin("bearer")) {
            // The value bearer() emits: the signed session cookie value.
            ctx.setHeader(
              "set-auth-token",
              `${token}.${await makeSignature(token, ctx.context.secret)}`,
            );
            ctx.setHeader("Access-Control-Expose-Headers", "set-auth-token");
          }
          return ctx.json({ token, user: parseUserOutput(ctx.context.options, found.user) });
        },
      ),
    },

    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/one-tap/callback",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { idToken?: unknown; nonce?: unknown };
            if (body.nonce === undefined) return;
            const audience = googleAudiences(ctx.context.options);
            const valid =
              typeof body.nonce === "string" &&
              body.nonce.length > 0 &&
              typeof body.idToken === "string" &&
              audience.length > 0 &&
              (await verifyGoogleIdToken({ token: body.idToken, audience, nonce: body.nonce }));
            if (!valid)
              throw new APIError("BAD_REQUEST", {
                code: "ONE_TAP_NONCE_MISMATCH",
                message: "The id token does not carry the nonce this sign-in sent",
              });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/callback/:id",
          handler: createAuthMiddleware(async (ctx) => {
            // Only a sign-in that created a session; a linking callback creates none.
            const created = ctx.context.newSession;
            if (!created) return;
            const location = ctx.context.responseHeaders?.get("location");
            if (!location || !isAbsoluteHttpUrl(location)) return;
            if (!ctx.context.isTrustedOrigin(location)) return;
            const challenge = (await getOAuthState())?.handoff;
            if (typeof challenge !== "string" || !B64URL_256.test(challenge)) return;

            const code = randomBytes(32).toString("base64url");
            await ctx.context.internalAdapter.createVerificationValue({
              identifier: handoffIdentifier(code),
              value: JSON.stringify({ sessionToken: created.session.token, challenge }),
              expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
            });
            ctx.setHeader("location", withHandoffFragment(location, code));
          }),
        },
      ],
    },

    rateLimit: [{ window: 60, max: 10, pathMatcher: (path) => path === "/social/handoff" }],
  };
}
