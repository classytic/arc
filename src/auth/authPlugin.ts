/**
 * Auth Plugin - Flexible, Database-Agnostic Authentication
 *
 * Arc provides JWT infrastructure and calls your authenticator.
 * You control ALL authentication logic.
 *
 * Design principles:
 * - Arc handles plumbing (JWT sign/verify utilities)
 * - App handles business logic (how to authenticate, where users live)
 * - Works with any database (Prisma, MongoDB, Postgres, none)
 * - Supports multiple auth strategies (JWT, API keys, sessions, etc.)
 *
 * @example
 * ```typescript
 * // In createApp
 * auth: {
 *   jwt: { secret: process.env.JWT_SECRET },
 *   authenticate: async (request, { jwt }) => {
 *     // Your auth logic - Arc never touches your database
 *     const token = request.headers.authorization?.split(' ')[1];
 *     if (!token) return null;
 *     const decoded = jwt.verify(token);
 *     return userRepo.findById(decoded.id);
 *   },
 * }
 * ```
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AuthPluginOptions,
  AuthHelpers,
  JwtContext,
  AuthenticatorContext,
  TokenPair,
} from '../types/index.js';
import type { RequestScope } from '../scope/types.js';
import { AUTHENTICATED_SCOPE } from '../scope/types.js';

// ============================================================================
// Fastify Type Extensions
// ============================================================================

declare module 'fastify' {
  interface FastifyInstance {
    /** Authenticate middleware - use in preHandler for protected routes */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Optional authenticate - parses JWT if present, doesn't fail if absent */
    optionalAuthenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Authorize middleware factory - checks if user has required roles */
    authorize: (...roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Auth helpers - issueTokens, jwt utilities */
    auth: AuthHelpers;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse expiration string to seconds
 */
function parseExpiresIn(input: string | undefined, defaultValue: number): number {
  if (!input) return defaultValue;
  if (/^\d+$/.test(input)) return parseInt(input, 10);

  const match = /^(\d+)\s*([smhd])$/i.exec(input);
  if (!match) return defaultValue;

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();

  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[unit] ?? 1);
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

// ============================================================================
// Auth Plugin
// ============================================================================

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify: FastifyInstance,
  opts: AuthPluginOptions = {}
) => {
  const { jwt: jwtConfig, authenticate: appAuthenticator, onFailure, userProperty = 'user', exposeAuthErrors = false } = opts;

  // ========================================
  // 1. Setup JWT Infrastructure (Optional)
  // ========================================

  let jwtContext: JwtContext | null = null;

  if (jwtConfig?.secret) {
    // Validate secret strength
    if (jwtConfig.secret.length < 32) {
      throw new Error(
        `JWT secret must be at least 32 characters (current: ${jwtConfig.secret.length}).\n` +
        'Use a strong random secret for production.'
      );
    }

    // Register @fastify/jwt
    const jwtPlugin = await import('@fastify/jwt');
    await fastify.register(jwtPlugin.default ?? jwtPlugin, {
      secret: jwtConfig.secret,
      sign: {
        expiresIn: jwtConfig.expiresIn ?? '15m',
        ...(jwtConfig.sign ?? {}),
      },
      verify: { ...(jwtConfig.verify ?? {}) },
    });

    // Create JWT context for authenticator
    // @fastify/jwt v10 uses fast-jwt under the hood
    const fastifyWithJwt = fastify as FastifyInstance & {
      jwt: {
        sign: (payload: Record<string, unknown>, options?: { expiresIn?: string | number; key?: string }) => string;
        verify: <T>(token: string, options?: { key?: string }) => T;
        decode: <T>(token: string) => T | null;
      };
    };

    jwtContext = {
      verify: <T = Record<string, unknown>>(token: string): T => {
        return fastifyWithJwt.jwt.verify<T>(token);
      },
      sign: (payload: Record<string, unknown>, options?: { expiresIn?: string }): string => {
        return fastifyWithJwt.jwt.sign(payload, options);
      },
      decode: <T = Record<string, unknown>>(token: string): T | null => {
        try {
          return fastifyWithJwt.jwt.decode<T>(token);
        } catch {
          return null;
        }
      },
    };

    fastify.log.debug('Auth: JWT infrastructure enabled');
  }

  // ========================================
  // 2. Create Authenticator Context
  // ========================================

  const authContext: AuthenticatorContext = {
    jwt: jwtContext,
    fastify,
  };

  // ========================================
  // 3. Create Authenticate Middleware
  // ========================================

  /**
   * Authenticate middleware
   *
   * Arc adds this to preHandler for non-public routes.
   * Calls app's authenticator or falls back to default JWT verify.
   */
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      let user: unknown = null;

      if (appAuthenticator) {
        // App-provided authenticator - full control
        user = await appAuthenticator(request, authContext);
      } else if (jwtContext) {
        // Default: JWT Bearer token verification
        const token = extractBearerToken(request);
        if (token) {
          const decoded = jwtContext.verify(token) as Record<string, unknown>;
          // Reject refresh tokens — they must only be used at the refresh endpoint
          if (decoded.type === 'refresh') {
            throw new Error('Refresh tokens cannot be used for authentication');
          }
          user = decoded;
        }
      } else {
        // No authenticator and no JWT - configuration error
        throw new Error(
          'No authenticator configured. Provide auth.authenticate function or auth.jwt.secret.'
        );
      }

      if (!user) {
        throw new Error('Authentication required');
      }

      // Always set canonical `request.user` for Arc internals, plus custom alias.
      const reqRecord = request as unknown as Record<string, unknown>;
      reqRecord.user = user;
      reqRecord[userProperty] = user;

      // Resolve scope from user claims (skip if custom authenticator already set it)
      if (!request.scope || request.scope.kind === 'public') {
        const userRecord = user as Record<string, unknown>;
        if (userRecord.organizationId) {
          // User has org context — set member scope
          request.scope = {
            kind: 'member',
            organizationId: String(userRecord.organizationId),
            orgRoles: Array.isArray(userRecord.orgRoles) ? userRecord.orgRoles as string[] : [],
          } satisfies RequestScope;
        } else {
          // No org context — authenticated only (can be upgraded via resolveOrgFromHeader hook)
          request.scope = AUTHENTICATED_SCOPE;
        }
      }

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Custom failure handler
      if (onFailure) {
        await onFailure(request, reply, error);
        return;
      }

      // Default 401 response — hide internal details unless explicitly opted-in
      const message = exposeAuthErrors ? error.message : 'Authentication required';

      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message,
      });
    }
  };

  // ========================================
  // 3b. Optional Authenticate Middleware
  // ========================================

  /**
   * Optional authenticate middleware
   *
   * Parses JWT if a Bearer token is present and populates request.user.
   * Does NOT fail if no token or invalid token — treats as unauthenticated.
   *
   * Used on allowPublic() routes so that downstream middleware (e.g. multiTenant
   * flexible filter) can apply org-scoped queries when a user IS authenticated.
   */
  const optionalAuthenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try {
      let user: unknown = null;

      if (appAuthenticator) {
        user = await appAuthenticator(request, authContext);
      } else if (jwtContext) {
        const token = extractBearerToken(request);
        if (token) {
          const decoded = jwtContext.verify(token) as Record<string, unknown>;
          // Silently ignore refresh tokens
          if (decoded.type === 'refresh') return;
          user = decoded;
        }
      }

      if (user) {
        const reqRecord = request as unknown as Record<string, unknown>;
        reqRecord.user = user;
        reqRecord[userProperty] = user;

        // Resolve scope from user claims (skip if custom authenticator already set it)
        if (!request.scope || request.scope.kind === 'public') {
          const userRecord = user as Record<string, unknown>;
          if (userRecord.organizationId) {
            request.scope = {
              kind: 'member',
              organizationId: String(userRecord.organizationId),
              orgRoles: Array.isArray(userRecord.orgRoles) ? userRecord.orgRoles as string[] : [],
            } satisfies RequestScope;
          } else {
            request.scope = AUTHENTICATED_SCOPE;
          }
        }
      }
      // No user = continue as unauthenticated (scope stays 'public')
    } catch {
      // Silently ignore auth errors — invalid/expired token = treat as unauthenticated
    }
  };

  // ========================================
  // 4. Create Auth Helpers
  // ========================================

  const refreshSecret = jwtConfig?.refreshSecret ?? jwtConfig?.secret;
  const accessExpiresIn = jwtConfig?.expiresIn ?? '15m';
  const refreshExpiresIn = jwtConfig?.refreshExpiresIn ?? '7d';

  /**
   * Issue access + refresh tokens
   * App calls this after validating credentials (login, OAuth, etc.)
   */
  const issueTokens = (
    payload: Record<string, unknown>,
    options?: { expiresIn?: string; refreshExpiresIn?: string }
  ): TokenPair => {
    if (!jwtContext) {
      throw new Error('JWT not configured. Provide auth.jwt.secret to use issueTokens.');
    }

    const accessTtl = options?.expiresIn ?? accessExpiresIn;
    const refreshTtl = options?.refreshExpiresIn ?? refreshExpiresIn;

    // Access token with full payload + explicit type
    const accessToken = jwtContext.sign({ ...payload, type: 'access' }, { expiresIn: accessTtl });

    // Refresh token with minimal payload (just id)
    const refreshPayload = payload.id
      ? { id: payload.id, type: 'refresh' }
      : payload._id
        ? { id: payload._id, type: 'refresh' }
        : { ...payload, type: 'refresh' };

    let refreshToken: string | undefined;
    if (refreshSecret) {
      const fastifyWithJwt = fastify as FastifyInstance & {
        jwt: { sign: (payload: Record<string, unknown>, options?: Record<string, unknown>) => string };
      };
      refreshToken = fastifyWithJwt.jwt.sign(refreshPayload, {
        expiresIn: refreshTtl,
        // Use refresh key if different from main secret (@fastify/jwt v10 uses 'key' instead of 'secret')
        ...(refreshSecret !== jwtConfig?.secret ? { key: refreshSecret } : {}),
      });
    }

    return {
      accessToken,
      refreshToken,
      expiresIn: parseExpiresIn(accessTtl, 900),
      refreshExpiresIn: refreshToken ? parseExpiresIn(refreshTtl, 604800) : undefined,
      tokenType: 'Bearer',
    };
  };

  /**
   * Verify refresh token
   * App calls this in refresh endpoint
   */
  const verifyRefreshToken = <T = Record<string, unknown>>(token: string): T => {
    if (!jwtContext) {
      throw new Error('JWT not configured. Provide auth.jwt.secret to use verifyRefreshToken.');
    }

    const fastifyWithJwt = fastify as FastifyInstance & {
      jwt: { verify: <T>(token: string, options?: Record<string, unknown>) => T };
    };

    const decoded = fastifyWithJwt.jwt.verify<Record<string, unknown>>(token, {
      // @fastify/jwt v10 uses 'key' instead of 'secret' for per-operation overrides
      ...(refreshSecret !== jwtConfig?.secret ? { key: refreshSecret } : {}),
    });

    // Enforce token type — reject access tokens used at the refresh endpoint
    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type: expected refresh token');
    }

    return decoded as T;
  };

  // ========================================
  // 5. Create Authorize Middleware Factory
  // ========================================

  /**
   * Authorize middleware factory
   * Creates a middleware that checks if user has required roles
   *
   * @example
   * preHandler: [fastify.authenticate, fastify.authorize('admin', 'superadmin')]
   */
  const authorize = (...allowedRoles: string[]) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const reqRecord = request as unknown as Record<string, unknown>;
      const user = (reqRecord[userProperty] ?? reqRecord.user) as
        | { roles?: string[] }
        | undefined;

      if (!user) {
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
          message: 'No user context',
        });
        return;
      }

      const userRoles = user.roles ?? [];

      // Special case: ['*'] means any authenticated user
      if (allowedRoles.length === 1 && allowedRoles[0] === '*') {
        return;
      }

      // Check if user has one of the required roles
      const hasRole = allowedRoles.some((role) => userRoles.includes(role));

      if (!hasRole) {
        reply.code(403).send({
          success: false,
          error: 'Forbidden',
          message: `Requires one of: ${allowedRoles.join(', ')}`,
        });
        return;
      }
    };
  };

  // ========================================
  // 6. Decorate Fastify Instance
  // ========================================

  const authHelpers: AuthHelpers = {
    jwt: jwtContext,
    issueTokens,
    verifyRefreshToken,
  };

  fastify.decorate('authenticate', authenticate);
  fastify.decorate('optionalAuthenticate', optionalAuthenticate);
  fastify.decorate('authorize', authorize);
  fastify.decorate('auth', authHelpers);

  fastify.log.debug(
    `Auth: Plugin registered (jwt=${!!jwtContext}, customAuth=${!!appAuthenticator})`
  );
};

// ============================================================================
// Export
// ============================================================================

export default fp(authPlugin, {
  name: 'arc-auth',
  fastify: '5.x',
});

export { authPlugin };
export type { AuthPluginOptions };
