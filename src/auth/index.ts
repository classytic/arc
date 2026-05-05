/**
 * Auth Module
 *
 * JWT authentication and authorization plugins.
 *
 * @example
 * import { authPlugin } from '@classytic/arc/auth';
 *
 * await fastify.register(authPlugin, {
 *   secret: process.env.JWT_SECRET,
 *   expiresIn: '7d',
 *   refreshExpiresIn: '7d',
 * });
 *
 * // Now available:
 * // fastify.authenticate - Verify JWT
 * // fastify.authorize(...roles) - Check roles
 * // fastify.auth.issueTokens(payload) - Issue access + refresh tokens with TTLs
 */

export type { AuthPluginOptions } from "./authPlugin.js";
export { authPlugin as authPluginFn, default as authPlugin } from "./authPlugin.js";
export type {
  BetterAuthAdapterOptions,
  BetterAuthAdapterResult,
  BetterAuthHandler,
} from "./betterAuth.js";
// Better Auth adapter
export { createBetterAuthAdapter } from "./betterAuth.js";
export type { BetterAuthOpenApiOptions } from "./betterAuthOpenApi.js";
// Better Auth OpenAPI extractor
export { extractBetterAuthOpenApi } from "./betterAuthOpenApi.js";
export type {
  MemorySessionStoreOptions,
  SessionCookieOptions,
  SessionData,
  SessionManagerOptions,
  SessionManagerResult,
  SessionStore,
} from "./sessionManager.js";
// Session Manager
export { createSessionManager, MemorySessionStore } from "./sessionManager.js";
// Trusted-origins helper — union of CORS allowlist + canonical FE URL.
// Pass result to `betterAuth({ trustedOrigins })` so BA's origin guard
// stays in sync with what CORS already permits.
export type {
  CorsOriginsConfig,
  MirrorTrustedOriginsOptions,
} from "./trustedOrigins.js";
export { mirrorTrustedOriginsFromCors } from "./trustedOrigins.js";
