/**
 * Base Types — universal primitives, user shape, response envelope.
 *
 * Also hosts the Fastify declaration merge for `request.scope` /
 * `request.user` / policy fields. Imported by every other types file
 * so the augmentation is always in scope.
 */

import type { FastifyRequest } from "fastify";
import type { UserBase } from "../permissions/types.js";
import type { RequestScope } from "../scope/types.js";

// ──────────────────────────────────────────────────────────────────────
// Fastify declaration merge — `request.scope` is always defined,
// `request.user` is `Record<string, unknown> | undefined`.
// ──────────────────────────────────────────────────────────────────────
declare module "fastify" {
  interface FastifyRequest {
    /** Request scope — set by auth adapter, read by permissions/presets/guards */
    scope: RequestScope;

    /**
     * Current user — set by auth adapter (Better Auth, JWT, custom).
     * `undefined` on public routes (`auth: false`) or unauthenticated requests.
     * Guard with `if (request.user)` on routes that allow anonymous access.
     *
     * Kept as required (not `user?`) because `@fastify/jwt` declares it
     * as required — declaration merges must have identical modifiers.
     * The `| undefined` in the type achieves the same DX.
     */
    user: Record<string, unknown> | undefined;

    /** Policy-injected query filters (e.g. ownership, org-scoping) */
    _policyFilters?: Record<string, unknown>;
    /** Field mask — fields to include/exclude in responses */
    fieldMask?: { include?: string[]; exclude?: string[] };
    /** Arbitrary policy metadata for downstream consumers */
    policyMetadata?: Record<string, unknown>;
    /** Document loaded by policy middleware for ownership checks */
    document?: unknown;
    /** Ownership check context (field name + user field) */
    _ownershipCheck?: Record<string, unknown>;
  }
}

export type AnyRecord = Record<string, unknown>;

/** MongoDB ObjectId — accepts string or any object with a `toString()` (e.g. mongoose ObjectId). */
export type ObjectId = string | { toString(): string };

/**
 * Flexible user type that accepts any object with id/_id properties.
 * The actual user structure is defined by your app's auth system.
 */
export type UserLike = UserBase & {
  /** User email (optional) */
  email?: string;
};

/** Extract user ID from a user object (supports both id and _id). */
export function getUserId(user: UserLike | null | undefined): string | undefined {
  if (!user) return undefined;
  const id = user.id ?? user._id;
  return id ? String(id) : undefined;
}

export interface UserOrganization {
  userId: string;
  organizationId: string;
  [key: string]: unknown;
}

export interface JWTPayload {
  sub: string;
  [key: string]: unknown;
}

/**
 * Standard API response envelope — `{ success, data?, error?, message?, meta? }`.
 * Used by Arc's default response shape.
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  meta?: Record<string, unknown>;
}

/**
 * Typed Fastify request with Arc decorations. Use in `raw: true` handlers
 * instead of `(req as any).user`.
 *
 * @example
 * ```typescript
 * import type { ArcRequest } from '@classytic/arc';
 *
 * handler: async (req: ArcRequest, reply) => {
 *   req.user?.id;                    // typed
 *   req.scope.organizationId;        // typed (when member)
 *   req.signal;                      // AbortSignal (Fastify 5)
 * }
 * ```
 */
export type ArcRequest = FastifyRequest & {
  scope: RequestScope;
  user: Record<string, unknown> | undefined;
  signal: AbortSignal;
};

/**
 * Wrap data in Arc's standard `{ success: true, data }` envelope.
 *
 * @example
 * ```typescript
 * handler: async (req, reply) => {
 *   const data = await getResults();
 *   return envelope(data);  // → { success: true, data }
 * }
 * ```
 */
export function envelope<T>(
  data: T,
  meta?: Record<string, unknown>,
): {
  success: true;
  data: T;
  [key: string]: unknown;
} {
  return { success: true, data, ...meta };
}
