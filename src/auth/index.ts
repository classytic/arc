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

export { default as authPlugin, authPlugin as authPluginFn } from './authPlugin.js';
export type { AuthPluginOptions } from './authPlugin.js';

// Better Auth adapter
export { createBetterAuthAdapter } from './betterAuth.js';
export type {
  BetterAuthAdapterOptions,
  BetterAuthAdapterResult,
  BetterAuthHandler,
} from './betterAuth.js';

// Better Auth OpenAPI extractor
export { extractBetterAuthOpenApi, zodLikeToJsonSchema } from './betterAuthOpenApi.js';
export type { BetterAuthOpenApiOptions } from './betterAuthOpenApi.js';

// Session Manager
export { createSessionManager, MemorySessionStore } from './sessionManager.js';
export type {
  SessionData,
  SessionStore,
  SessionCookieOptions,
  SessionManagerOptions,
  SessionManagerResult,
  MemorySessionStoreOptions,
} from './sessionManager.js';
