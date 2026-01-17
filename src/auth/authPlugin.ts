/**
 * Auth Plugin
 *
 * JWT authentication with role-based authorization.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthPluginOptions, UserBase } from '../types/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authorize: (...roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    auth: {
      authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
      authorize: (...roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
      issueTokens: (
        payload: Record<string, unknown>,
        options?: {
          refreshPayload?: Record<string, unknown>;
          expiresIn?: string;
          refreshExpiresIn?: string;
        }
      ) => {
        token: string;
        refreshToken?: string;
        expiresIn?: number;
        refreshExpiresIn?: number;
      };
    };
  }
}

// Note: user property on FastifyRequest is extended by @fastify/jwt

function resolveExpiresInSeconds(input: string | undefined): number | undefined {
  if (!input) return undefined;
  if (/^\d+$/.test(input)) return parseInt(input, 10);

  const match = /^(\d+)\s*([smhd])$/i.exec(input);
  if (!match) return undefined;

  const valueText = match[1];
  const unitText = match[2];
  if (!valueText || !unitText) return undefined;

  const value = parseInt(valueText, 10);
  const unit = unitText.toLowerCase();
  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      return undefined;
  }
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify: FastifyInstance,
  opts: AuthPluginOptions = {}
) => {
  const {
    secret = process.env.JWT_SECRET,
    expiresIn = '7d',
    refreshSecret,
    refreshExpiresIn = '7d',
    userProperty = 'user',
    superadminRoles = ['superadmin'],
    decorate = true,
    jwt,
  } = opts;

  // Always require explicit secret
  if (!secret) {
    throw new Error(
      'JWT secret is required for authentication.\n' +
      'Set JWT_SECRET environment variable or pass secret in options.\n' +
      'For testing, use an explicit secret like "test-secret-min-32-chars-long".\n' +
      'Docs: https://github.com/classytic/arc#security'
    );
  }

  // Validate secret strength (minimum 32 characters)
  if (secret.length < 32) {
    throw new Error(
      `JWT secret must be at least 32 characters (current: ${secret.length}).\n` +
      'Use a strong random secret for production.\n' +
      'Docs: https://github.com/classytic/arc#security'
    );
  }

  // Register JWT plugin if not already registered
  const fastifyWithJwt = fastify as FastifyInstance & { jwt?: unknown };
  if (!fastifyWithJwt.jwt) {
    const jwtPlugin = await import('@fastify/jwt');
    await fastify.register(jwtPlugin.default ?? jwtPlugin, {
      secret,
      sign: { expiresIn, ...(jwt?.sign ?? {}) },
      verify: { ...(jwt?.verify ?? {}) },
    });
  }

  const authenticate = async function (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    try {
      await (request as FastifyRequest & { jwtVerify: () => Promise<void> }).jwtVerify();
    } catch (err) {
      // Security: Don't expose JWT error details in production
      const message = process.env.NODE_ENV === 'production'
        ? 'Invalid or expired token'
        : (err as Error).message;

      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message,
      });
      return;
    }
  };

  const authorize = function (...allowedRoles: string[]) {
    return async function (
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> {
      const user = (request as FastifyRequest & { [key: string]: unknown })[userProperty] as UserBase | undefined;

      if (!user) {
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
          message: 'No user context',
        });
        return;
      }

      // Superadmin bypasses all role checks
      const userWithRoles = user as { roles?: string[] };
      if (superadminRoles.some((role: string) => userWithRoles.roles?.includes(role))) {
        return;
      }

      // Special case: ['*'] means authenticated only, any role is ok
      if (allowedRoles.length === 1 && allowedRoles[0] === '*') {
        return;
      }

      // Check if user has one of the required roles
      const userRoles = userWithRoles.roles ?? [];
      const hasRole = allowedRoles.some((role) => userRoles.includes(role));

      if (!hasRole) {
        reply.code(403).send({
          success: false,
          error: 'Forbidden',
          message: `Requires one of: ${allowedRoles.join(', ')}`,
          required: allowedRoles,
          current: userRoles,
        });
        return;
      }
    };
  };

  const issueTokens = (
    payload: Record<string, unknown>,
    options?: {
      refreshPayload?: Record<string, unknown>;
      expiresIn?: string;
      refreshExpiresIn?: string;
    }
  ) => {
    const accessExpiresIn = options?.expiresIn ?? expiresIn;
    const refreshTtl = options?.refreshExpiresIn ?? refreshExpiresIn;
    const accessTtlSeconds = resolveExpiresInSeconds(accessExpiresIn);
    const refreshTtlSeconds = resolveExpiresInSeconds(refreshTtl);
    const refreshPayload =
      options?.refreshPayload ??
      (payload.id ? { id: payload.id } : payload._id ? { id: payload._id } : payload);

    const token = (fastify as any).jwt.sign(payload, {
      expiresIn: accessExpiresIn,
    });

    const refreshToken = refreshTtl
      ? (fastify as any).jwt.sign(refreshPayload, {
          expiresIn: refreshTtl,
          secret: refreshSecret ?? secret,
        })
      : undefined;

    return {
      token,
      refreshToken,
      expiresIn: accessTtlSeconds,
      refreshExpiresIn: refreshToken ? refreshTtlSeconds : undefined,
    };
  };

  if (decorate) {
    fastify.decorate('authenticate', authenticate);
    fastify.decorate('authorize', authorize);
    fastify.decorate('auth', { authenticate, authorize, issueTokens });
  }

  fastify.log?.info?.('Auth plugin registered');
};

export default fp(authPlugin, {
  name: 'arc-auth',
  fastify: '5.x',
});

export { authPlugin };
export type { AuthPluginOptions };
