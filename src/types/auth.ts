/**
 * Auth Types — JWT context, authenticator function, token pair, auth
 * helpers, and the full auth-plugin options.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "./base.js";

/**
 * JWT utilities provided to authenticator. Arc provides the helpers;
 * apps use them as needed.
 */
export interface JwtContext {
  /** Verify a JWT token and return decoded payload */
  verify: <T = Record<string, unknown>>(token: string) => T;
  /** Sign a payload and return JWT token */
  sign: (payload: Record<string, unknown>, options?: { expiresIn?: string }) => string;
  /** Decode without verification (for inspection) */
  decode: <T = Record<string, unknown>>(token: string) => T | null;
}

/** Context passed to app's authenticator function. */
export interface AuthenticatorContext {
  /** JWT utilities (available if `jwt.secret` provided) */
  jwt: JwtContext | null;
  /** Fastify instance for advanced use cases */
  fastify: FastifyInstance;
}

/**
 * App-provided authenticator function. Arc calls this for every
 * non-public route. The app has full control over authentication logic.
 *
 * Return a user object to authenticate, `null`/`undefined` to reject.
 *
 * @example
 * ```typescript
 * authenticate: async (request, { jwt }) => {
 *   const token = request.headers.authorization?.split(' ')[1];
 *   if (!token || !jwt) return null;
 *   const decoded = jwt.verify(token);
 *   return userRepo.findById(decoded.id);
 * }
 * ```
 */
export type Authenticator = (
  request: FastifyRequest,
  context: AuthenticatorContext,
) => Promise<unknown | null> | unknown | null;

/** Token pair returned by `issueTokens` helper. */
export interface TokenPair {
  /** Access token (JWT) */
  accessToken: string;
  /** Refresh token (JWT with longer expiry) */
  refreshToken?: string;
  /** Access token expiry in seconds */
  expiresIn: number;
  /** Refresh token expiry in seconds */
  refreshExpiresIn?: number;
  /** Token type (always 'Bearer') */
  tokenType: "Bearer";
}

/**
 * Auth helpers exposed on `fastify.auth`.
 *
 * @example
 * ```typescript
 * const tokens = fastify.auth.issueTokens({
 *   id: user._id,
 *   email: user.email,
 *   role: user.role,
 * });
 * return { success: true, ...tokens, user };
 * ```
 */
export interface AuthHelpers {
  /** JWT utilities (if configured) */
  jwt: JwtContext | null;
  /**
   * Issue access + refresh tokens for a user. App calls this after
   * validating credentials.
   */
  issueTokens: (
    payload: Record<string, unknown>,
    options?: { expiresIn?: string; refreshExpiresIn?: string },
  ) => TokenPair;
  /** Verify a refresh token and return decoded payload. */
  verifyRefreshToken: <T = Record<string, unknown>>(token: string) => T;
}

/**
 * Auth plugin options — clean, minimal configuration.
 *
 * Arc provides JWT infrastructure and calls your authenticator. You
 * control all authentication logic.
 *
 * @example
 * ```typescript
 * auth: {
 *   jwt: { secret: process.env.JWT_SECRET },
 *   authenticate: async (request, { jwt }) => {
 *     const token = request.headers.authorization?.split(' ')[1];
 *     if (!token) return null;
 *     const decoded = jwt.verify(token);
 *     return userRepo.findById(decoded.id);
 *   },
 * }
 * ```
 */
export interface AuthPluginOptions {
  /**
   * JWT configuration (optional but recommended). If provided, JWT
   * utilities are available in the authenticator context.
   */
  jwt?: {
    /** JWT secret (required for JWT features) */
    secret: string;
    /** Access token expiry (default: '15m') */
    expiresIn?: string;
    /** Refresh token secret (defaults to main secret) */
    refreshSecret?: string;
    /** Refresh token expiry (default: '7d') */
    refreshExpiresIn?: string;
    /** Additional `@fastify/jwt` sign options */
    sign?: Record<string, unknown>;
    /** Additional `@fastify/jwt` verify options */
    verify?: Record<string, unknown>;
  };
  /**
   * Custom authenticator function. Arc calls this for non-public routes.
   * If not provided and `jwt.secret` is set, uses default `jwtVerify`.
   */
  authenticate?: Authenticator;
  /**
   * Custom auth failure handler. Customize the 401 response when
   * authentication fails.
   */
  onFailure?: (request: FastifyRequest, reply: FastifyReply, error?: Error) => void | Promise<void>;
  /**
   * Expose detailed auth error messages in 401 responses. When `false`
   * (default), returns generic "Authentication required". Decoupled from
   * log level — set explicitly per environment.
   */
  exposeAuthErrors?: boolean;
  /** Property name to store user on request (default: 'user') */
  userProperty?: string;
  /**
   * Custom token extractor for the built-in JWT auth path. Defaults to
   * extracting Bearer token from Authorization header. Use when tokens
   * are in HttpOnly cookies, custom headers, or query params.
   *
   * @example
   * ```typescript
   * tokenExtractor: (request) => request.cookies?.['auth-token'] ?? null,
   * ```
   */
  tokenExtractor?: (request: FastifyRequest) => string | null;
  /**
   * Token revocation check — called after JWT verification succeeds.
   * Return `true` to reject the token (revoked), `false` to allow.
   *
   * **Fail-closed**: if the check throws, the token is treated as revoked.
   *
   * @example
   * ```typescript
   * isRevoked: async (decoded) => {
   *   return await redis.sismember('revoked-tokens', decoded.jti ?? decoded.id);
   * },
   * ```
   */
  isRevoked?: (decoded: Record<string, unknown>) => boolean | Promise<boolean>;
  /**
   * Enforce strict JWT `type` claim validation (default: `true`).
   *
   * When enabled, `authenticate` requires `decoded.type === "access"`.
   * Tokens with a missing or unexpected `type` claim are rejected —
   * defence in depth for apps that reuse the JWT secret to sign other
   * token kinds (invite links, one-time verification codes).
   *
   * Arc's own `issueTokens` always sets `type: "access"` or
   * `type: "refresh"`, so this default is safe for Arc-generated tokens.
   *
   * Set to `false` ONLY when you must accept tokens signed without a
   * `type` claim (e.g. a legacy issuer you don't control). In that mode
   * Arc still rejects tokens explicitly marked `type: "refresh"`.
   */
  strictTokenType?: boolean;
}
