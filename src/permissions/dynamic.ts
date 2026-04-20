/**
 * Permission Matrices — role × resource × action mapping.
 *
 * Two flavors:
 *   - `createOrgPermissions` — static, compile-time-known matrix
 *   - `createDynamicPermissionMatrix` — runtime-resolved, with optional
 *     cache + cross-node event invalidation
 *
 * Both produce `PermissionCheck` instances that compose with the rest of
 * the permission system.
 */

import { randomUUID } from "node:crypto";
import type { CacheLogger, CacheStore } from "../cache/interface.js";
import { MemoryCacheStore } from "../cache/memory.js";
import { getRequestScope as getScope, isElevated, isMember } from "../scope/types.js";
import { requireOrgMembership, requireOrgRole, requireTeamMembership } from "./scope.js";
import type { PermissionCheck, PermissionContext } from "./types.js";

export interface DynamicPermissionMatrixConfig {
  /**
   * Resolve role → resource → actions map dynamically (DB / API / config service).
   * Called at permission-check time (or cache miss when cache enabled).
   */
  resolveRolePermissions: (
    ctx: PermissionContext,
  ) =>
    | Record<string, Record<string, readonly string[]>>
    | Promise<Record<string, Record<string, readonly string[]>>>;
  /**
   * Optional cache store adapter. Use MemoryCacheStore for single-instance
   * apps, RedisCacheStore for distributed setups.
   */
  cacheStore?: CacheStore<Record<string, Record<string, readonly string[]>>>;
  /** Optional logger for cache/runtime failures (default: console). */
  logger?: CacheLogger;
  /**
   * Convenience in-memory cache config. If `cacheStore` is not provided
   * and `ttlSeconds > 0`, Arc creates an internal MemoryCacheStore.
   */
  cache?: {
    /** Cache TTL in seconds */
    ttlSeconds: number;
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
  /** Called on remote invalidation for app-specific cleanup (e.g. resolver cache). */
  onRemoteInvalidation?: (orgId: string) => void | Promise<void>;
  /** Custom event type (default: 'arc.permissions.invalidated'). */
  eventType?: string;
}

export interface DynamicPermissionMatrix {
  can: (permissions: Record<string, readonly string[]>) => PermissionCheck;
  canAction: (resource: string, action: string) => PermissionCheck;
  requireRole: (...roles: string[]) => PermissionCheck;
  requireMembership: () => PermissionCheck;
  requireTeamMembership: () => PermissionCheck;
  /** Invalidate cached permissions for a specific organization. */
  invalidateByOrg: (orgId: string) => Promise<void>;
  clearCache: () => Promise<void>;

  /**
   * Connect to an event system for cross-node cache invalidation.
   *
   * Late-binding: call after the event plugin is registered (e.g. in an
   * `onReady` hook). Once connected, `invalidateByOrg()` auto-publishes an
   * event, and incoming events from other nodes trigger local cache
   * invalidation. Echo is suppressed via per-process nodeId matching.
   */
  connectEvents(events: PermissionEventBus, options?: ConnectEventsOptions): Promise<void>;

  /** Disconnect from the event system. Safe to call even if never connected. */
  disconnectEvents(): Promise<void>;

  /** Whether events are currently connected. */
  readonly eventsConnected: boolean;
}

/**
 * Create a static role × resource × action permission system. Compile-time
 * matrix — use when role mappings are known at build time and don't change
 * per-deployment.
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
 * Create a dynamic role-based permission matrix. Use when role/action
 * mappings are managed outside code (admin UI, DB-stored ACLs, remote
 * policy service).
 *
 * Supports:
 * - Org role union (any assigned org role can grant)
 * - Global bypass roles
 * - Wildcard resource/action (`*`)
 * - Optional in-memory or distributed cache
 * - Cross-node invalidation via the event bus
 */
export function createDynamicPermissionMatrix(
  config: DynamicPermissionMatrixConfig,
): DynamicPermissionMatrix {
  const logger = config.logger ?? console;
  const configuredTtlSeconds = config.cache?.ttlSeconds ?? 0;
  const hasExternalStore = !!config.cacheStore;
  const cacheTtlSeconds =
    configuredTtlSeconds > 0 ? configuredTtlSeconds : hasExternalStore ? 300 : 0;

  const internalStore =
    !config.cacheStore && cacheTtlSeconds > 0
      ? new MemoryCacheStore<Record<string, Record<string, readonly string[]>>>({
          defaultTtlSeconds: cacheTtlSeconds,
          maxEntries: config.cache?.maxEntries ?? 1000,
        })
      : undefined;

  const cacheStore = config.cacheStore ?? internalStore;
  const trackedKeys = new Set<string>();

  const nodeId = randomUUID().slice(0, 8);
  const DEFAULT_EVENT_TYPE = "arc.permissions.invalidated";

  interface InternalEventBridge {
    publish: <T>(type: string, payload: T) => Promise<void>;
    unsubscribe: (() => void) | null;
    eventType: string;
    onRemoteInvalidation?: (orgId: string) => void | Promise<void>;
  }

  let eventBridge: InternalEventBridge | null = null;

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
      await cacheStore.set(cacheKey, value, cacheTtlSeconds);
      trackedKeys.add(cacheKey);

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
      if (eventBridge) {
        await this.disconnectEvents();
      }

      const eventType = options?.eventType ?? DEFAULT_EVENT_TYPE;

      const unsubscribeFn = await events.subscribe(eventType, async (event) => {
        const payload = event.payload as { orgId?: string; nodeId?: string } | undefined;
        if (!payload?.orgId) return;

        if (payload.nodeId === nodeId) return;

        await localInvalidateByOrg(payload.orgId);

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
