/**
 * Permission System
 *
 * Clean, function-based permission system.
 * PermissionCheck is THE ONLY way to define permissions.
 *
 * @example
 * ```typescript
 * import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
 *
 * defineResource({
 *   permissions: {
 *     list: allowPublic(),
 *     get: allowPublic(),
 *     create: requireAuth(),
 *     update: requireRoles(['admin', 'editor']),
 *     delete: requireRoles(['admin']),
 *   }
 * });
 * ```
 */

export type { RoleHierarchy } from "./roleHierarchy.js";
export { createRoleHierarchy } from "./roleHierarchy.js";
// Re-export types
export type {
  PermissionCheck,
  PermissionContext,
  PermissionResult,
  UserBase,
} from "./types.js";
export { getUserRoles, normalizeRoles } from "./types.js";

import { randomUUID } from "node:crypto";
import type { CacheLogger, CacheStore } from "../cache/interface.js";
import { MemoryCacheStore } from "../cache/memory.js";
import { getUserRoles } from "./types.js";

export interface DynamicPermissionMatrixConfig {
  /**
   * Resolve role → resource → actions map dynamically (DB/API/config service).
   * Called at permission-check time (or cache miss if cache enabled).
   */
  resolveRolePermissions: (
    ctx: PermissionContext,
  ) =>
    | Record<string, Record<string, readonly string[]>>
    | Promise<Record<string, Record<string, readonly string[]>>>;
  /**
   * Optional cache store adapter.
   * Use MemoryCacheStore for single-instance apps or RedisCacheStore for distributed setups.
   */
  cacheStore?: CacheStore<Record<string, Record<string, readonly string[]>>>;
  /** Optional logger for cache/runtime failures (default: console) */
  logger?: CacheLogger;
  /**
   * Legacy convenience in-memory cache config.
   * If `cacheStore` is not provided and ttlMs > 0, Arc creates an internal MemoryCacheStore.
   */
  cache?: {
    /** Cache TTL in milliseconds */
    ttlMs: number;
    /** Optional custom cache key builder */
    key?: (ctx: PermissionContext) => string | null | undefined;
    /** Hard entry cap for internal memory store (default: 1000) */
    maxEntries?: number;
  };
}

/** Minimal publish/subscribe interface for cross-node cache invalidation. */
export interface PermissionEventBus {
  publish: <T>(type: string, payload: T) => Promise<void>;
  subscribe: (
    pattern: string,
    handler: (event: { payload: unknown }) => void | Promise<void>,
  ) => Promise<(() => void) | undefined>;
}

export interface ConnectEventsOptions {
  /** Called on remote invalidation for app-specific cleanup (e.g., resolver cache) */
  onRemoteInvalidation?: (orgId: string) => void | Promise<void>;
  /** Custom event type (default: 'arc.permissions.invalidated') */
  eventType?: string;
}

export interface DynamicPermissionMatrix {
  can: (permissions: Record<string, readonly string[]>) => PermissionCheck;
  canAction: (resource: string, action: string) => PermissionCheck;
  requireRole: (...roles: string[]) => PermissionCheck;
  requireMembership: () => PermissionCheck;
  requireTeamMembership: () => PermissionCheck;
  /** Invalidate cached permissions for a specific organization */
  invalidateByOrg: (orgId: string) => Promise<void>;
  clearCache: () => Promise<void>;

  /**
   * Connect to an event system for cross-node cache invalidation.
   *
   * Late-binding: call after the event plugin is registered (e.g., in onReady hook).
   * Once connected, `invalidateByOrg()` auto-publishes an event, and incoming
   * events from other nodes trigger local cache invalidation.
   * Echo is suppressed via per-process nodeId matching.
   */
  connectEvents(events: PermissionEventBus, options?: ConnectEventsOptions): Promise<void>;

  /** Disconnect from the event system. Safe to call even if never connected. */
  disconnectEvents(): Promise<void>;

  /** Whether events are currently connected. */
  readonly eventsConnected: boolean;
}

// Permission presets — common patterns in one call
import * as presets from "./presets.js";

export type {
  FieldPermission,
  FieldPermissionMap,
  FieldPermissionType,
} from "./fields.js";
// Field-level permissions
export {
  applyFieldReadPermissions,
  applyFieldWritePermissions,
  fields,
  resolveEffectiveRoles,
} from "./fields.js";
export {
  adminOnly,
  authenticated,
  fullPublic,
  ownerWithAdminBypass,
  publicRead,
  publicReadAdminWrite,
  readOnly,
} from "./presets.js";
export { presets as permissions };

import type { FastifyRequest } from "fastify";
import type { RequestScope } from "../scope/types.js";
import {
  getUserId as getScopeUserId,
  getTeamId,
  isElevated,
  isMember,
  PUBLIC_SCOPE,
} from "../scope/types.js";
import type { PermissionCheck, PermissionContext, PermissionResult } from "./types.js";

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Allow public access (no authentication required)
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: allowPublic(),
 *   get: allowPublic(),
 * }
 * ```
 */
export function allowPublic(): PermissionCheck {
  const check: PermissionCheck = () => true;
  // Mark as public for OpenAPI documentation and introspection
  check._isPublic = true;
  return check;
}

/**
 * Require authentication (any authenticated user)
 *
 * @example
 * ```typescript
 * permissions: {
 *   create: requireAuth(),
 *   update: requireAuth(),
 * }
 * ```
 */
export function requireAuth(): PermissionCheck {
  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }
    return true;
  };
  return check;
}

/**
 * Require specific roles
 *
 * @param roles - Required roles (user needs at least one)
 * @param options - Optional bypass roles
 *
 * @example
 * ```typescript
 * permissions: {
 *   create: requireRoles(['admin', 'editor']),
 *   delete: requireRoles(['admin']),
 * }
 *
 * // With bypass roles
 * permissions: {
 *   update: requireRoles(['owner'], { bypassRoles: ['admin', 'superadmin'] }),
 * }
 * ```
 */
export function requireRoles(
  roles: readonly string[],
  options?: {
    bypassRoles?: readonly string[];
    /**
     * Also check org membership roles (`scope.orgRoles`) when in org context.
     * Default: `false` — only checks platform roles (`user.role`).
     *
     * Set to `true` when using Better Auth organization plugin where roles like
     * 'admin' are assigned at the org level, not the user level.
     *
     * For org-only role checks, prefer `requireOrgRole('admin')` instead.
     */
    includeOrgRoles?: boolean;
  },
): PermissionCheck {
  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

    const userRoles = getUserRoles(ctx.user);

    // Check bypass roles first
    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    // Check platform roles (user.role)
    if (roles.some((r) => userRoles.includes(r))) {
      return true;
    }

    // Optionally check org roles when in org context
    if (options?.includeOrgRoles) {
      const scope = getScope(ctx.request);
      if (isMember(scope) && roles.some((r) => scope.orgRoles.includes(r))) {
        return true;
      }
    }

    return {
      granted: false,
      reason: `Required roles: ${roles.join(", ")}`,
    };
  };
  check._roles = roles;
  return check;
}

/**
 * Unified role check — checks both platform roles AND org roles.
 *
 * This is the recommended helper for Better Auth organization plugin users.
 * It checks `user.role` (platform) first, then `scope.orgRoles` (org membership).
 * Elevated scope always passes.
 *
 * For platform-only checks: use `requireRoles(['admin'])`
 * For org-only checks: use `requireOrgRole('admin')`
 *
 * @example
 * ```typescript
 * permissions: {
 *   create: roles('admin', 'editor'),  // passes if user has role at either level
 *   delete: roles('admin'),
 * }
 * ```
 */
export function roles(...args: string[] | [readonly string[]]): PermissionCheck {
  const roleList: readonly string[] = Array.isArray(args[0]) ? args[0] : (args as string[]);

  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

    // Platform roles (user.role)
    const userRoles = getUserRoles(ctx.user);
    if (roleList.some((r) => userRoles.includes(r))) {
      return true;
    }

    // Org roles (scope.orgRoles — when in org context)
    const scope = getScope(ctx.request);
    if (isElevated(scope)) return true;
    if (isMember(scope) && roleList.some((r) => scope.orgRoles.includes(r))) {
      return true;
    }

    return {
      granted: false,
      reason: `Required roles: ${roleList.join(", ")}`,
    };
  };
  check._roles = roleList;
  return check;
}

/**
 * Require resource ownership
 *
 * Returns filters to scope queries to user's owned resources.
 *
 * @param ownerField - Field containing owner ID (default: 'userId')
 * @param options - Optional bypass roles
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: requireOwnership('userId'),
 *   delete: requireOwnership('createdBy', { bypassRoles: ['admin'] }),
 * }
 * ```
 */
export function requireOwnership<TDoc = Record<string, unknown>>(
  ownerField: Extract<keyof TDoc, string> | string = "userId",
  options?: { bypassRoles?: readonly string[] },
): PermissionCheck<TDoc> {
  return (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

    const userRoles = getUserRoles(ctx.user);

    // Check bypass roles
    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    // Return filters to scope to owned resources
    // Prefer scope.userId (set by auth adapters), fall back to user object
    const userId = getScopeUserId(getScope(ctx.request)) ?? ctx.user.id ?? ctx.user._id;
    if (!userId) {
      return { granted: false, reason: "User identity missing (no id or _id)" };
    }
    return {
      granted: true,
      filters: { [ownerField]: userId },
    };
  };
}

/**
 * Combine multiple checks - ALL must pass (AND logic)
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: allOf(
 *     requireAuth(),
 *     requireRoles(['editor']),
 *     requireOwnership('createdBy')
 *   ),
 * }
 * ```
 */
export function allOf(...checks: PermissionCheck[]): PermissionCheck {
  return async (ctx) => {
    let mergedFilters: Record<string, unknown> = {};

    for (const check of checks) {
      const result = await check(ctx);
      const normalized: PermissionResult =
        typeof result === "boolean" ? { granted: result } : result;

      if (!normalized.granted) {
        return normalized;
      }

      // Merge filters
      if (normalized.filters) {
        mergedFilters = { ...mergedFilters, ...normalized.filters };
      }
    }

    return {
      granted: true,
      filters: Object.keys(mergedFilters).length > 0 ? mergedFilters : undefined,
    };
  };
}

/**
 * Combine multiple checks - ANY must pass (OR logic)
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: anyOf(
 *     requireRoles(['admin']),
 *     requireOwnership('createdBy')
 *   ),
 * }
 * ```
 */
export function anyOf(...checks: PermissionCheck[]): PermissionCheck {
  return async (ctx) => {
    const reasons: string[] = [];

    for (const check of checks) {
      const result = await check(ctx);
      const normalized: PermissionResult =
        typeof result === "boolean" ? { granted: result } : result;

      if (normalized.granted) {
        return normalized;
      }

      if (normalized.reason) {
        reasons.push(normalized.reason);
      }
    }

    return {
      granted: false,
      reason: reasons.join("; "),
    };
  };
}

/**
 * Deny all access
 *
 * @example
 * ```typescript
 * permissions: {
 *   delete: denyAll('Deletion not allowed'),
 * }
 * ```
 */
export function denyAll(reason = "Access denied"): PermissionCheck {
  return () => ({ granted: false, reason });
}

/**
 * Dynamic permission based on context
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: when((ctx) => ctx.data?.status === 'draft'),
 * }
 * ```
 */
export function when<TDoc = Record<string, unknown>>(
  condition: (ctx: PermissionContext<TDoc>) => boolean | Promise<boolean>,
): PermissionCheck<TDoc> {
  return async (ctx) => {
    const result = await condition(ctx);
    return {
      granted: result,
      reason: result ? undefined : "Condition not met",
    };
  };
}

// ============================================================================
// Organization Permission Helpers
// ============================================================================

/** Read request.scope safely */
function getScope(request: FastifyRequest): RequestScope {
  return request.scope ?? PUBLIC_SCOPE;
}

/**
 * Require membership in the active organization.
 * User must be authenticated AND have an active org (member or elevated scope).
 *
 * Reads `request.scope` set by auth adapters.
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: requireOrgMembership(),
 *   get: requireOrgMembership(),
 * }
 * ```
 */
export function requireOrgMembership<TDoc = Record<string, unknown>>(): PermissionCheck<TDoc> {
  const check: PermissionCheck<TDoc> = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

    const scope = getScope(ctx.request);
    if (isElevated(scope)) return true;
    if (isMember(scope)) return true;

    return { granted: false, reason: "Organization membership required" };
  };
  check._orgPermission = "membership";
  return check;
}

/**
 * Require specific org-level roles.
 * Reads `request.scope.orgRoles` (set by auth adapters).
 * Elevated scope always passes (platform admin bypass).
 *
 * @param roles - Required org roles (user needs at least one)
 *
 * @example
 * ```typescript
 * permissions: {
 *   create: requireOrgRole('admin', 'owner'),
 *   delete: requireOrgRole('owner'),
 * }
 * ```
 */
export function requireOrgRole<TDoc = Record<string, unknown>>(
  ...args: string[] | [readonly string[]]
): PermissionCheck<TDoc> {
  // Support both: requireOrgRole('admin', 'owner') and requireOrgRole(['admin', 'owner'])
  const roles: readonly string[] = Array.isArray(args[0]) ? args[0] : (args as string[]);

  const check: PermissionCheck<TDoc> = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

    const scope = getScope(ctx.request);
    if (isElevated(scope)) return true;

    if (!isMember(scope)) {
      return { granted: false, reason: "Organization membership required" };
    }

    if (roles.some((r) => scope.orgRoles.includes(r))) {
      return true;
    }

    return {
      granted: false,
      reason: `Required org roles: ${roles.join(", ")}`,
    };
  };
  check._orgRoles = roles;
  return check;
}

/**
 * Create a scoped permission system for resource-action patterns.
 * Maps org roles to fine-grained permissions without external API calls.
 *
 * @example
 * ```typescript
 * const perms = createOrgPermissions({
 *   statements: {
 *     product: ['create', 'update', 'delete'],
 *     order: ['create', 'approve'],
 *   },
 *   roles: {
 *     owner: { product: ['create', 'update', 'delete'], order: ['create', 'approve'] },
 *     admin: { product: ['create', 'update'], order: ['create'] },
 *     member: { product: [], order: [] },
 *   },
 * });
 *
 * defineResource({
 *   permissions: {
 *     create: perms.can({ product: ['create'] }),
 *     delete: perms.can({ product: ['delete'] }),
 *   }
 * });
 * ```
 */
export function createOrgPermissions(config: {
  statements: Record<string, readonly string[]>;
  roles: Record<string, Record<string, readonly string[]>>;
}): {
  can: (permissions: Record<string, string[]>) => PermissionCheck;
  requireRole: (...roles: string[]) => PermissionCheck;
  requireMembership: () => PermissionCheck;
  requireTeamMembership: () => PermissionCheck;
} {
  const { roles: roleMap } = config;

  function hasPermissions(orgRoles: string[], required: Record<string, string[]>): boolean {
    // User's effective permissions = union of all their role permissions
    for (const [resource, actions] of Object.entries(required)) {
      for (const action of actions) {
        const granted = orgRoles.some((role) => {
          const perms = roleMap[role]?.[resource];
          return perms?.includes(action);
        });
        if (!granted) return false;
      }
    }
    return true;
  }

  return {
    can(permissions: Record<string, string[]>): PermissionCheck {
      return (ctx) => {
        if (!ctx.user) {
          return { granted: false, reason: "Authentication required" };
        }

        const scope = getScope(ctx.request);
        if (isElevated(scope)) return true;

        if (!isMember(scope)) {
          return { granted: false, reason: "Organization membership required" };
        }

        if (hasPermissions(scope.orgRoles, permissions)) {
          return true;
        }

        const needed = Object.entries(permissions)
          .map(([r, a]) => `${r}:[${a.join(",")}]`)
          .join(", ");
        return {
          granted: false,
          reason: `Missing permissions: ${needed}`,
        };
      };
    },

    requireRole(...roles: string[]): PermissionCheck {
      return requireOrgRole(roles);
    },

    requireMembership(): PermissionCheck {
      return requireOrgMembership();
    },

    requireTeamMembership(): PermissionCheck {
      return requireTeamMembership();
    },
  };
}

/**
 * Create a dynamic role-based permission matrix.
 *
 * Use this when role/action mappings are managed outside code
 * (e.g., admin UI matrix, DB-stored ACLs, remote policy service).
 *
 * Supports:
 * - org role union (any assigned org role can grant)
 * - global bypass roles
 * - wildcard resource/action (`*`)
 * - optional in-memory cache
 */
export function createDynamicPermissionMatrix(
  config: DynamicPermissionMatrixConfig,
): DynamicPermissionMatrix {
  const logger = config.logger ?? console;
  const legacyTtlMs = config.cache?.ttlMs ?? 0;
  const hasExternalStore = !!config.cacheStore;
  const cacheTtlMs = legacyTtlMs > 0 ? legacyTtlMs : hasExternalStore ? 300_000 : 0;

  const internalStore =
    !config.cacheStore && cacheTtlMs > 0
      ? new MemoryCacheStore<Record<string, Record<string, readonly string[]>>>({
          defaultTtlMs: cacheTtlMs,
          maxEntries: config.cache?.maxEntries ?? 1000,
        })
      : undefined;

  const cacheStore = config.cacheStore ?? internalStore;
  const trackedKeys = new Set<string>();

  // ── Cross-node event bridge (late-binding) ───────────────────────
  const nodeId = randomUUID().slice(0, 8);
  const DEFAULT_EVENT_TYPE = "arc.permissions.invalidated";

  interface InternalEventBridge {
    publish: <T>(type: string, payload: T) => Promise<void>;
    unsubscribe: (() => void) | null;
    eventType: string;
    onRemoteInvalidation?: (orgId: string) => void | Promise<void>;
  }

  let eventBridge: InternalEventBridge | null = null;

  /** Clear local cache for an org without publishing events (avoids infinite loops). */
  async function localInvalidateByOrg(orgId: string): Promise<void> {
    if (!cacheStore) return;
    const prefix = `${orgId}::`;
    const toDelete: string[] = [];
    for (const key of trackedKeys) {
      if (key.startsWith(prefix)) toDelete.push(key);
    }
    for (const key of toDelete) {
      try {
        await cacheStore.delete(key);
        trackedKeys.delete(key);
      } catch (error) {
        logger.warn(
          `[DynamicPermissionMatrix] invalidateByOrg delete failed for '${key}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  function isActionAllowed(actions: readonly string[] | undefined, action: string): boolean {
    if (!actions || actions.length === 0) return false;
    return actions.includes("*") || actions.includes(action);
  }

  function roleAllows(
    matrix: Record<string, Record<string, readonly string[]>>,
    role: string,
    resource: string,
    action: string,
  ): boolean {
    const rolePermissions = matrix[role];
    if (!rolePermissions) return false;
    const resourceActions = rolePermissions[resource];
    const wildcardResourceActions = rolePermissions["*"];
    return (
      isActionAllowed(resourceActions, action) || isActionAllowed(wildcardResourceActions, action)
    );
  }

  function buildDefaultCacheKey(
    ctx: PermissionContext,
    orgId?: string,
    orgRoles?: string[],
  ): string {
    const userId = String(ctx.user?.id ?? ctx.user?._id ?? "anon");
    const roles = (orgRoles ?? []).slice().sort().join(",");
    return `${orgId ?? "no-org"}::${roles}::${userId}`;
  }

  async function resolveMatrix(
    ctx: PermissionContext,
    orgId?: string,
    orgRoles?: string[],
  ): Promise<Record<string, Record<string, readonly string[]>>> {
    if (!cacheStore) {
      return config.resolveRolePermissions(ctx);
    }

    const customKey = config.cache?.key?.(ctx);
    const cacheKey = customKey ?? buildDefaultCacheKey(ctx, orgId, orgRoles);

    if (!cacheKey) {
      return config.resolveRolePermissions(ctx);
    }

    try {
      const hit = await cacheStore.get(cacheKey);
      if (hit) return hit;
    } catch (error) {
      logger.warn(
        `[DynamicPermissionMatrix] Cache get failed for '${cacheKey}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const value = await config.resolveRolePermissions(ctx);

    try {
      await cacheStore.set(cacheKey, value, { ttlMs: cacheTtlMs });
      trackedKeys.add(cacheKey);

      // Cap tracked keys to prevent unbounded memory growth
      const maxTracked = config.cache?.maxEntries ?? 10_000;
      if (trackedKeys.size > maxTracked) {
        const overflow = trackedKeys.size - maxTracked;
        const iter = trackedKeys.values();
        for (let i = 0; i < overflow; i++) {
          const oldest = iter.next().value;
          if (oldest) trackedKeys.delete(oldest);
        }
      }
    } catch (error) {
      logger.warn(
        `[DynamicPermissionMatrix] Cache set failed for '${cacheKey}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return value;
  }

  function can(required: Record<string, readonly string[]>): PermissionCheck {
    return async (ctx) => {
      if (!ctx.user) {
        return { granted: false, reason: "Authentication required" };
      }

      const scope = getScope(ctx.request);
      if (isElevated(scope)) return true;

      if (!isMember(scope)) {
        return { granted: false, reason: "Organization membership required" };
      }

      const orgRoles = scope.orgRoles;
      if (orgRoles.length === 0) {
        return { granted: false, reason: "Not a member of this organization" };
      }

      let matrix: Record<string, Record<string, readonly string[]>>;
      try {
        matrix = await resolveMatrix(ctx, scope.organizationId, orgRoles);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          granted: false,
          reason: `Permission matrix resolution failed: ${message}`,
        };
      }

      for (const [resource, actions] of Object.entries(required)) {
        for (const action of actions) {
          const granted = orgRoles.some((role) => roleAllows(matrix, role, resource, action));
          if (!granted) {
            return {
              granted: false,
              reason: `Missing permission: ${resource}:${action}`,
            };
          }
        }
      }

      return true;
    };
  }

  return {
    can,
    canAction(resource: string, action: string): PermissionCheck {
      return can({ [resource]: [action] });
    },
    requireRole(...roles: string[]): PermissionCheck {
      return requireOrgRole(roles);
    },
    requireMembership(): PermissionCheck {
      return requireOrgMembership();
    },
    requireTeamMembership(): PermissionCheck {
      return requireTeamMembership();
    },
    async invalidateByOrg(orgId: string): Promise<void> {
      await localInvalidateByOrg(orgId);

      // Publish cross-node invalidation event (fail-open)
      if (eventBridge) {
        try {
          await eventBridge.publish(eventBridge.eventType, { orgId, nodeId });
        } catch (error) {
          logger.warn(
            `[DynamicPermissionMatrix] Failed to publish invalidation event for org '${orgId}': ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
    async clearCache(): Promise<void> {
      if (!cacheStore) return;

      if (cacheStore.clear) {
        try {
          await cacheStore.clear();
          trackedKeys.clear();
          return;
        } catch (error) {
          logger.warn(
            `[DynamicPermissionMatrix] cacheStore.clear failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Fallback for stores without clear(): delete known keys for this process.
      for (const key of trackedKeys) {
        try {
          await cacheStore.delete(key);
        } catch (error) {
          logger.warn(
            `[DynamicPermissionMatrix] Cache delete failed for '${key}': ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      trackedKeys.clear();
    },

    async connectEvents(events: PermissionEventBus, options?: ConnectEventsOptions): Promise<void> {
      // Disconnect previous connection if any (idempotent reconnect)
      if (eventBridge) {
        await this.disconnectEvents();
      }

      const eventType = options?.eventType ?? DEFAULT_EVENT_TYPE;

      const unsubscribeFn = await events.subscribe(eventType, async (event) => {
        const payload = event.payload as { orgId?: string; nodeId?: string } | undefined;
        if (!payload?.orgId) return;

        // Echo dedup: skip events published by this node
        if (payload.nodeId === nodeId) return;

        // Clear local permission matrix cache (no re-publish)
        await localInvalidateByOrg(payload.orgId);

        // App-specific cleanup callback
        if (options?.onRemoteInvalidation) {
          try {
            await options.onRemoteInvalidation(payload.orgId);
          } catch (error) {
            logger.warn(
              `[DynamicPermissionMatrix] onRemoteInvalidation callback failed for org '${payload.orgId}': ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      });

      eventBridge = {
        publish: events.publish,
        unsubscribe: typeof unsubscribeFn === "function" ? unsubscribeFn : null,
        eventType,
        onRemoteInvalidation: options?.onRemoteInvalidation,
      };
    },

    async disconnectEvents(): Promise<void> {
      if (!eventBridge) return;
      try {
        eventBridge.unsubscribe?.();
      } catch (error) {
        logger.warn(
          `[DynamicPermissionMatrix] disconnectEvents unsubscribe failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      eventBridge = null;
    },

    get eventsConnected(): boolean {
      return eventBridge !== null;
    },
  };
}

// ============================================================================
// Team Permission Helpers
// ============================================================================

/**
 * Require membership in the active team.
 * User must be authenticated, a member of the active org, AND have an active team.
 *
 * Better Auth teams are flat member groups (no team-level roles).
 * Reads `request.scope.teamId` set by the Better Auth adapter.
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: requireTeamMembership(),
 *   create: requireTeamMembership(),
 * }
 * ```
 */
export function requireTeamMembership<TDoc = Record<string, unknown>>(): PermissionCheck<TDoc> {
  const check: PermissionCheck<TDoc> = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

    const scope = getScope(ctx.request);
    if (isElevated(scope)) return true;

    if (!isMember(scope)) {
      return { granted: false, reason: "Organization membership required" };
    }

    const teamId = getTeamId(scope);
    if (!teamId) {
      return { granted: false, reason: "No active team" };
    }

    return true;
  };
  check._teamPermission = "membership";
  return check;
}
