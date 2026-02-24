/**
 * Session Management for Arc
 *
 * Lightweight cookie-based session manager that coexists with JWT and Better Auth.
 * Users pick their auth strategy — this is one option alongside authPlugin and
 * createBetterAuthAdapter.
 *
 * Features:
 * - Cookie-based session tokens (HMAC-signed)
 * - Session refresh with throttling (updateAge)
 * - Fresh session concept for sensitive operations (freshAge)
 * - Session revocation (single, all, all-except-current)
 * - Pluggable session stores (Memory, Redis, etc.)
 *
 * @example
 * ```typescript
 * import { createSessionManager, MemorySessionStore } from '@classytic/arc/auth';
 *
 * const sessions = createSessionManager({
 *   store: new MemorySessionStore(),
 *   secret: process.env.SESSION_SECRET,
 *   maxAge: 7 * 24 * 60 * 60, // 7 days
 *   updateAge: 24 * 60 * 60,  // refresh every 24h
 *   freshAge: 10 * 60,        // 10 min for sensitive ops
 * });
 *
 * // Register plugin
 * await fastify.register(sessions.plugin);
 *
 * // Protect sensitive routes
 * fastify.post('/change-password', {
 *   preHandler: [fastify.authenticate, sessions.requireFresh],
 * }, handler);
 * ```
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

// ============================================================================
// Types
// ============================================================================

/**
 * Session data stored in the session store.
 */
export interface SessionData {
  /** User ID associated with this session */
  userId: string;
  /** Timestamp (ms since epoch) when session was created */
  createdAt: number;
  /** Timestamp (ms since epoch) when session was last refreshed */
  updatedAt: number;
  /** Timestamp (ms since epoch) when session expires */
  expiresAt: number;
  /** Optional metadata attached to the session */
  metadata?: Record<string, unknown>;
}

/**
 * Session store interface.
 * Implement this for custom storage backends (Redis, database, etc.).
 */
export interface SessionStore {
  /** Retrieve a session by ID. Returns null if not found or expired. */
  get(sessionId: string): Promise<SessionData | null>;
  /** Create or update a session. */
  set(sessionId: string, data: SessionData): Promise<void>;
  /** Delete a single session. */
  delete(sessionId: string): Promise<void>;
  /** Delete all sessions for a user. */
  deleteAll(userId: string): Promise<void>;
  /** Delete all sessions for a user except the specified one. */
  deleteAllExcept(userId: string, currentSessionId: string): Promise<void>;
}

/**
 * Cookie configuration options.
 */
export interface SessionCookieOptions {
  /** Send cookie only over HTTPS (default: true in production) */
  secure?: boolean;
  /** Prevent client-side JavaScript access (default: true) */
  httpOnly?: boolean;
  /** SameSite attribute (default: 'lax') */
  sameSite?: 'strict' | 'lax' | 'none';
  /** Cookie path (default: '/') */
  path?: string;
  /** Cookie domain */
  domain?: string;
}

/**
 * Options for creating a session manager.
 */
export interface SessionManagerOptions {
  /** Session store implementation */
  store: SessionStore;
  /** Secret for signing session cookies (min 32 characters) */
  secret: string;
  /** Session max age in seconds (default: 604800 = 7 days) */
  maxAge?: number;
  /** Minimum interval between session updates in seconds (default: 86400 = 24h) */
  updateAge?: number;
  /** Time in seconds after which a session is no longer "fresh" (default: 600 = 10 min) */
  freshAge?: number;
  /** Cookie name (default: 'arc.session') */
  cookieName?: string;
  /** Cookie options */
  cookie?: SessionCookieOptions;
}

/**
 * Return type from createSessionManager.
 */
export interface SessionManagerResult {
  /** Fastify plugin that adds session middleware */
  plugin: FastifyPluginAsync;
  /** PreHandler that rejects requests without a fresh session */
  requireFresh: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

// ============================================================================
// Fastify Type Extensions
// ============================================================================

declare module 'fastify' {
  interface FastifyInstance {
    /** Authenticate middleware — validates session and sets request.user */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Session management helpers */
    sessionManager: {
      /** Create a new session for a user */
      createSession: (
        userId: string,
        metadata?: Record<string, unknown>,
      ) => Promise<{ sessionId: string; cookie: string }>;
      /** Revoke a specific session */
      revokeSession: (sessionId: string) => Promise<void>;
      /** Revoke all sessions for a user */
      revokeAllSessions: (userId: string) => Promise<void>;
      /** Revoke all sessions except the current one */
      revokeOtherSessions: (userId: string, currentSessionId: string) => Promise<void>;
      /** Refresh a session (reset updatedAt, extend expiry if needed) */
      refreshSession: (sessionId: string) => Promise<SessionData | null>;
    };
  }

  interface FastifyRequest {
    /** Current session data (set by session plugin) */
    session?: SessionData & { id: string };
  }
}

// ============================================================================
// Cookie Helpers
// ============================================================================

/**
 * Sign a session ID using HMAC-SHA256.
 * Returns `sessionId.signature` format.
 */
function signSessionId(sessionId: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(sessionId)
    .digest('base64url');
  return `${sessionId}.${signature}`;
}

/**
 * Verify and extract session ID from a signed cookie value.
 * Returns the session ID if valid, null otherwise.
 */
function verifySessionId(signedValue: string, secret: string): string | null {
  const lastDotIndex = signedValue.lastIndexOf('.');
  if (lastDotIndex === -1) return null;

  const sessionId = signedValue.slice(0, lastDotIndex);
  const signature = signedValue.slice(lastDotIndex + 1);

  if (!sessionId || !signature) return null;

  const expectedSignature = createHmac('sha256', secret)
    .update(sessionId)
    .digest('base64url');

  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length) return null;

  return timingSafeEqual(sigBuf, expectedBuf) ? sessionId : null;
}

/**
 * Parse cookies from a Cookie header string.
 * Returns a map of cookie name to value.
 */
function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  const pairs = header.split(';');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;

    const name = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (name) {
      cookies.set(name, decodeURIComponent(value));
    }
  }

  return cookies;
}

/**
 * Build a Set-Cookie header value.
 */
function buildSetCookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
  options: SessionCookieOptions,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAgeSeconds}`,
    `Path=${options.path ?? '/'}`,
  ];

  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }

  if (options.secure ?? (process.env.NODE_ENV === 'production')) {
    parts.push('Secure');
  }

  parts.push(`SameSite=${capitalize(options.sameSite ?? 'lax')}`);

  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }

  return parts.join('; ');
}

/**
 * Build a Set-Cookie header that clears (expires) the cookie.
 */
function buildClearCookieHeader(name: string, options: SessionCookieOptions): string {
  return buildSetCookieHeader(name, '', 0, options);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================================
// MemorySessionStore
// ============================================================================

export interface MemorySessionStoreOptions {
  /** Cleanup interval in milliseconds (default: 60000 = 1 min) */
  cleanupIntervalMs?: number;
}

/**
 * In-memory session store for development and single-instance deployments.
 * NOT suitable for multi-instance/clustered deployments — use Redis or similar.
 */
export class MemorySessionStore implements SessionStore {
  private sessions: Map<string, SessionData> = new Map();
  /** Reverse index: userId -> Set<sessionId> for efficient bulk operations */
  private userIndex: Map<string, Set<string>> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: MemorySessionStoreOptions = {}) {
    const intervalMs = options.cleanupIntervalMs ?? 60_000;
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, intervalMs);

    // Don't keep Node process alive just for cleanup
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Check expiration
    if (Date.now() > session.expiresAt) {
      await this.delete(sessionId);
      return null;
    }

    return session;
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    this.sessions.set(sessionId, data);

    // Update user index
    let userSessions = this.userIndex.get(data.userId);
    if (!userSessions) {
      userSessions = new Set();
      this.userIndex.set(data.userId, userSessions);
    }
    userSessions.add(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Clean up user index
      const userSessions = this.userIndex.get(session.userId);
      if (userSessions) {
        userSessions.delete(sessionId);
        if (userSessions.size === 0) {
          this.userIndex.delete(session.userId);
        }
      }
    }
    this.sessions.delete(sessionId);
  }

  async deleteAll(userId: string): Promise<void> {
    const userSessions = this.userIndex.get(userId);
    if (!userSessions) return;

    for (const sessionId of userSessions) {
      this.sessions.delete(sessionId);
    }
    this.userIndex.delete(userId);
  }

  async deleteAllExcept(userId: string, currentSessionId: string): Promise<void> {
    const userSessions = this.userIndex.get(userId);
    if (!userSessions) return;

    for (const sessionId of userSessions) {
      if (sessionId !== currentSessionId) {
        this.sessions.delete(sessionId);
      }
    }

    // Rebuild the set with only the current session
    if (userSessions.has(currentSessionId)) {
      this.userIndex.set(userId, new Set([currentSessionId]));
    } else {
      this.userIndex.delete(userId);
    }
  }

  /**
   * Close the store and clean up resources.
   */
  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
    this.userIndex.clear();
  }

  /**
   * Get current stats (for debugging/monitoring).
   */
  getStats(): { sessions: number; users: number } {
    return {
      sessions: this.sessions.size,
      users: this.userIndex.size,
    };
  }

  /**
   * Remove expired sessions.
   */
  private cleanup(): void {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions) {
      if (now > session.expiresAt) {
        // Clean up user index
        const userSessions = this.userIndex.get(session.userId);
        if (userSessions) {
          userSessions.delete(sessionId);
          if (userSessions.size === 0) {
            this.userIndex.delete(session.userId);
          }
        }
        this.sessions.delete(sessionId);
      }
    }
  }
}

// ============================================================================
// Session Manager Factory
// ============================================================================

/**
 * Create a session manager for Arc.
 *
 * Returns a Fastify plugin and a `requireFresh` preHandler.
 *
 * The plugin:
 * - Parses session cookie on each request
 * - Validates session against the store
 * - Sets `request.user` and `request.session` from session data
 * - Refreshes session token if older than `updateAge`
 * - Provides `fastify.authenticate` decorator
 * - Provides `fastify.sessionManager` decorator for session CRUD
 *
 * @example
 * ```typescript
 * import { createSessionManager, MemorySessionStore } from '@classytic/arc/auth';
 *
 * const sessions = createSessionManager({
 *   store: new MemorySessionStore(),
 *   secret: process.env.SESSION_SECRET!,
 *   maxAge: 7 * 24 * 60 * 60,
 *   updateAge: 24 * 60 * 60,
 *   freshAge: 10 * 60,
 * });
 *
 * await fastify.register(sessions.plugin);
 *
 * // Login route
 * fastify.post('/login', async (request, reply) => {
 *   const user = await authenticateUser(request.body);
 *   const { cookie } = await fastify.sessionManager.createSession(user.id);
 *   reply.header('Set-Cookie', cookie);
 *   return { success: true, user };
 * });
 *
 * // Protected route
 * fastify.get('/me', {
 *   preHandler: [fastify.authenticate],
 * }, async (request) => {
 *   return { user: request.user };
 * });
 *
 * // Sensitive route (requires fresh session)
 * fastify.post('/change-password', {
 *   preHandler: [fastify.authenticate, sessions.requireFresh],
 * }, handler);
 * ```
 */
export function createSessionManager(options: SessionManagerOptions): SessionManagerResult {
  const {
    store,
    secret,
    maxAge: maxAgeSeconds = 7 * 24 * 60 * 60, // 7 days
    updateAge: updateAgeSeconds = 24 * 60 * 60, // 24 hours
    freshAge: freshAgeSeconds = 10 * 60, // 10 minutes
    cookieName = 'arc.session',
    cookie: cookieOptions = {},
  } = options;

  // Validate secret strength
  if (secret.length < 32) {
    throw new Error(
      `Session secret must be at least 32 characters (current: ${secret.length}). ` +
      'Use a strong random secret for production.',
    );
  }

  // Convert to milliseconds for internal use
  const maxAgeMs = maxAgeSeconds * 1000;
  const updateAgeMs = updateAgeSeconds * 1000;
  const freshAgeMs = freshAgeSeconds * 1000;

  // ========================================
  // Internal Helpers
  // ========================================

  /**
   * Create a new session and return the signed cookie value.
   */
  async function createSession(
    userId: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ sessionId: string; cookie: string }> {
    const sessionId = randomUUID();
    const now = Date.now();

    const sessionData: SessionData = {
      userId,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + maxAgeMs,
      metadata,
    };

    await store.set(sessionId, sessionData);

    const signedId = signSessionId(sessionId, secret);
    const cookie = buildSetCookieHeader(cookieName, signedId, maxAgeSeconds, cookieOptions);

    return { sessionId, cookie };
  }

  /**
   * Refresh a session: update the updatedAt timestamp and optionally extend expiry.
   */
  async function refreshSession(sessionId: string): Promise<SessionData | null> {
    const session = await store.get(sessionId);
    if (!session) return null;

    const now = Date.now();
    const updatedSession: SessionData = {
      ...session,
      updatedAt: now,
      // Extend expiry from now if less than maxAge remaining
      expiresAt: Math.max(session.expiresAt, now + maxAgeMs),
    };

    await store.set(sessionId, updatedSession);
    return updatedSession;
  }

  // ========================================
  // requireFresh preHandler
  // ========================================

  /**
   * PreHandler that rejects requests if the session is not "fresh".
   * A session is fresh if it was last updated within `freshAge` seconds.
   * Use this for sensitive operations like password changes, email changes, etc.
   */
  const requireFresh = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = request.session;

    if (!session) {
      reply.code(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const elapsed = Date.now() - session.updatedAt;
    if (elapsed > freshAgeMs) {
      reply.code(403).send({
        success: false,
        error: 'SessionNotFresh',
        message: 'Session is not fresh. Please re-authenticate to perform this action.',
        code: 'SESSION_NOT_FRESH',
      });
      return;
    }
  };

  // ========================================
  // Fastify Plugin
  // ========================================

  const sessionPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
    // ---- authenticate decorator ----

    const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // Parse cookies from header
      const cookieHeader = request.headers.cookie;
      const cookies = parseCookies(
        typeof cookieHeader === 'string' ? cookieHeader : undefined,
      );

      const signedValue = cookies.get(cookieName);
      if (!signedValue) {
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
          message: 'No session cookie',
        });
        return;
      }

      // Verify signature
      const sessionId = verifySessionId(signedValue, secret);
      if (!sessionId) {
        // Tampered or invalid cookie — clear it
        reply.header('Set-Cookie', buildClearCookieHeader(cookieName, cookieOptions));
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
          message: 'Invalid session',
        });
        return;
      }

      // Load session from store
      const session = await store.get(sessionId);
      if (!session) {
        // Session deleted or expired — clear cookie
        reply.header('Set-Cookie', buildClearCookieHeader(cookieName, cookieOptions));
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
          message: 'Session expired or revoked',
        });
        return;
      }

      // Check expiration (belt-and-suspenders, store should handle this too)
      if (Date.now() > session.expiresAt) {
        await store.delete(sessionId);
        reply.header('Set-Cookie', buildClearCookieHeader(cookieName, cookieOptions));
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
          message: 'Session expired',
        });
        return;
      }

      // Set user and session on request
      (request as unknown as Record<string, unknown>).user = {
        id: session.userId,
        ...session.metadata,
      };
      (request as unknown as Record<string, unknown>).session = {
        ...session,
        id: sessionId,
      };

      // Throttled session refresh: only update if older than updateAge
      const timeSinceUpdate = Date.now() - session.updatedAt;
      if (timeSinceUpdate > updateAgeMs) {
        const updatedSession = await refreshSession(sessionId);
        if (updatedSession) {
          // Re-sign and send updated cookie
          const signedId = signSessionId(sessionId, secret);
          const newCookie = buildSetCookieHeader(
            cookieName,
            signedId,
            maxAgeSeconds,
            cookieOptions,
          );
          reply.header('Set-Cookie', newCookie);

          // Update the session on request with refreshed data
          (request as unknown as Record<string, unknown>).session = {
            ...updatedSession,
            id: sessionId,
          };
        }
      }
    };

    // ---- Decorate fastify ----

    if (!fastify.hasDecorator('authenticate')) {
      fastify.decorate('authenticate', authenticate);
    }

    fastify.decorate('sessionManager', {
      createSession,
      revokeSession: (sessionId: string) => store.delete(sessionId),
      revokeAllSessions: (userId: string) => store.deleteAll(userId),
      revokeOtherSessions: (userId: string, currentSessionId: string) =>
        store.deleteAllExcept(userId, currentSessionId),
      refreshSession,
    });

    fastify.log.debug(
      `Session: Plugin registered (cookieName=${cookieName}, maxAge=${maxAgeSeconds}s, updateAge=${updateAgeSeconds}s, freshAge=${freshAgeSeconds}s)`,
    );
  };

  // Wrap with fastify-plugin for encapsulation transparency
  const plugin = fp(sessionPlugin, {
    name: 'arc-session',
    fastify: '5.x',
  }) as FastifyPluginAsync;

  return { plugin, requireFresh };
}
