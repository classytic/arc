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
