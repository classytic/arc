/**
 * @classytic/arc — MCP Session Cache
 *
 * Per-session MCP server cache with TTL and max capacity.
 * Each MCP session gets its own McpServer + Transport pair (SDK requires 1:1).
 * Expired sessions are cleaned up automatically.
 *
 * Pattern follows websocket.ts RoomManager — instance-scoped, no globals.
 */

import type { SessionEntry } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_SESSIONS = 1000;

// ============================================================================
// Session Cache
// ============================================================================

export class McpSessionCache {
  private sessions = new Map<string, SessionEntry>();
  private ttlMs: number;
  private maxSessions: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { ttlMs?: number; maxSessions?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;

    // Periodic cleanup every half-TTL
    if (this.ttlMs > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), Math.max(this.ttlMs / 2, 5000));
      // Allow the process to exit without waiting for the timer
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  /** Get an existing session by ID */
  get(sessionId: string): SessionEntry | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    // Check expiry
    if (Date.now() - entry.lastAccessed > this.ttlMs) {
      this.remove(sessionId);
      return undefined;
    }

    return entry;
  }

  /** Store a new session */
  set(sessionId: string, entry: SessionEntry): void {
    // Evict oldest if at capacity
    if (this.sessions.size >= this.maxSessions && !this.sessions.has(sessionId)) {
      this.evictOldest();
    }

    entry.lastAccessed = Date.now();
    this.sessions.set(sessionId, entry);
  }

  /** Refresh the TTL on a session */
  touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastAccessed = Date.now();
    }
  }

  /** Remove and close a session */
  remove(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.closeTransport(entry);
      this.sessions.delete(sessionId);
    }
  }

  /** Remove all expired sessions */
  cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastAccessed > this.ttlMs) {
        this.closeTransport(entry);
        this.sessions.delete(id);
      }
    }
  }

  /** Close all sessions and stop cleanup timer */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [id, entry] of this.sessions) {
      this.closeTransport(entry);
      this.sessions.delete(id);
    }
  }

  /** Current session count */
  get size(): number {
    return this.sessions.size;
  }

  // ============================================================================
  // Internal
  // ============================================================================

  /** Evict the oldest (least recently accessed) session */
  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, entry] of this.sessions) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.remove(oldestId);
    }
  }

  /** Safely close a transport */
  private closeTransport(entry: SessionEntry): void {
    try {
      const transport = entry.transport as { close?: () => void | Promise<void> };
      if (transport && typeof transport.close === "function") {
        transport.close();
      }
    } catch {
      // Best-effort cleanup — don't throw during shutdown
    }
  }
}
