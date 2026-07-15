/**
 * Auth strategy types for `createApp()` — the `AuthOption` discriminated
 * union (`jwt` / `betterAuth` / `custom` / `authenticator`) and its members.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ExternalOpenApiPaths } from "../../docs/externalPaths.js";
import type { Authenticator } from "../../types/index.js";

/**
 * Arc's built-in JWT auth
 *
 * Registers @fastify/jwt, wires up `fastify.authenticate`, and
 * exposes `fastify.auth` helpers (issueTokens, verifyRefreshToken).
 *
 * @example
 * ```typescript
 * const app = await createApp({
 *   auth: {
 *     type: 'jwt',
 *     jwt: { secret: process.env.JWT_SECRET },
 *   },
 * });
 *
 * // With custom authenticator
 * const app = await createApp({
 *   auth: {
 *     type: 'jwt',
 *     jwt: { secret: process.env.JWT_SECRET },
 *     authenticate: async (request, { jwt }) => {
 *       const token = request.headers.authorization?.split(' ')[1];
 *       if (!token) return null;
 *       const decoded = jwt.verify(token);
 *       return userRepo.findById(decoded.id);
 *     },
 *   },
 * });
 * ```
 */
export interface JwtAuthOption {
  type: "jwt";

  /**
   * JWT configuration (optional but recommended)
   * If provided, jwt utilities are available in authenticator context
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
    /** Additional @fastify/jwt sign options */
    sign?: Record<string, unknown>;
    /** Additional @fastify/jwt verify options */
    verify?: Record<string, unknown>;
  };

  /**
   * Custom authenticator function (recommended)
   *
   * Arc calls this for non-public routes.
   * Return user object to authenticate, null/undefined to reject.
   *
   * If not provided and jwt.secret is set, uses default jwtVerify.
   */
  authenticate?: Authenticator;

  /**
   * Custom auth failure handler
   * Customize the 401 response when authentication fails
   */
  onFailure?: (request: FastifyRequest, reply: FastifyReply, error?: Error) => void | Promise<void>;

  /**
   * Expose detailed auth error messages in 401 responses.
   * When false (default), returns generic "Authentication required".
   * When true, includes the actual error message for debugging.
   * Decoupled from log level — set explicitly per environment.
   */
  exposeAuthErrors?: boolean;

  /**
   * Property name to store user on request (default: 'user')
   */
  userProperty?: string;

  /**
   * Token revocation check — called after JWT verification.
   * Return `true` to reject the token (fail-closed: errors also reject).
   *
   * @example
   * ```typescript
   * isRevoked: async (decoded) => {
   *   return revokedTokens.has(decoded.jti as string);
   * },
   * ```
   */
  isRevoked?: (decoded: Record<string, unknown>) => boolean | Promise<boolean>;
}

/**
 * Better Auth adapter integration
 *
 * When provided, Arc registers the Better Auth plugin (which sets up
 * auth routes and decorates fastify.authenticate) and skips Arc's
 * built-in JWT auth setup entirely.
 *
 * @example
 * ```typescript
 * import { createBetterAuthAdapter } from '@classytic/arc-better-auth';
 *
 * const app = await createApp({
 *   auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth: myBetterAuth }) },
 * });
 * ```
 */
/** The shape `createBetterAuthAdapter()` returns. */
export interface BetterAuthAdapterResult {
  plugin: FastifyPluginAsync;
  openapi?: ExternalOpenApiPaths;
}

export interface BetterAuthOption {
  type: "betterAuth";
  /**
   * Better Auth adapter — the result of `createBetterAuthAdapter()`, or a
   * sync/async THUNK returning it (2.22). The thunk resolves during auth
   * registration — AFTER `beforeBoot` — for adapters whose construction
   * needs a live DB (Better Auth's `mongodbAdapter(mongoose.connection
   * .getClient().db())` requires an OPEN connection, so an eager value
   * forces hosts back into connect-before-createApp ordering dances):
   *
   * ```typescript
   * createApp({
   *   beforeBoot: () => connectDatabase(),
   *   auth: { type: 'betterAuth', betterAuth: () => createBetterAuthAdapter({ auth: getAuth() }) },
   * });
   * ```
   */
  betterAuth:
    | BetterAuthAdapterResult
    | (() => BetterAuthAdapterResult | Promise<BetterAuthAdapterResult>);
}

/**
 * Custom auth plugin — full control over authentication setup
 *
 * The plugin is registered directly on the Fastify instance.
 * It must decorate `fastify.authenticate` for protected routes to work.
 *
 * @example
 * ```typescript
 * const app = await createApp({
 *   auth: {
 *     type: 'custom',
 *     plugin: async (fastify) => {
 *       fastify.decorate('authenticate', async (request, reply) => { ... });
 *     },
 *   },
 * });
 * ```
 */
export interface CustomPluginAuthOption {
  type: "custom";
  /** Custom Fastify plugin that sets up authentication */
  plugin: FastifyPluginAsync;
}

/**
 * Custom authenticator function — lightweight alternative to a full plugin
 *
 * Arc decorates `fastify.authenticate` with this function directly.
 * No JWT setup, no Arc auth plugin — just your function.
 *
 * @example
 * ```typescript
 * const app = await createApp({
 *   auth: {
 *     type: 'authenticator',
 *     authenticate: async (request, reply) => {
 *       const session = await validateSession(request);
 *       if (!session) reply.code(401).send({ error: 'Unauthorized' });
 *       request.user = session.user;
 *     },
 *   },
 * });
 * ```
 */
export interface CustomAuthenticatorOption {
  type: "authenticator";
  /** Authenticate function — decorates fastify.authenticate directly */
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /**
   * Optional authenticate function for public routes.
   * If not provided, Arc auto-generates one by wrapping `authenticate` and
   * intercepting 401/403 responses so unauthenticated requests proceed as public.
   * Provide this if your authenticator has side effects that shouldn't run on public routes.
   */
  optionalAuthenticate?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * All supported auth configuration shapes
 *
 * - `false` — Disable authentication entirely
 * - `JwtAuthOption` — Arc's built-in JWT auth (`type: 'jwt'`)
 * - `BetterAuthOption` — Better Auth adapter integration (`type: 'betterAuth'`)
 * - `CustomPluginAuthOption` — Your own Fastify auth plugin (`type: 'custom'`)
 * - `CustomAuthenticatorOption` — A bare authenticate function (`type: 'authenticator'`)
 */
export type AuthOption =
  | false
  | JwtAuthOption
  | BetterAuthOption
  | CustomPluginAuthOption
  | CustomAuthenticatorOption;
