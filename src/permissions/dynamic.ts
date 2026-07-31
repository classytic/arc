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
import { arcLog } from "../logger/index.js";
import { isElevated, isMember } from "../scope/types.js";
import { scopeOf } from "./context.js";
import { deny } from "./core.js";
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
          return deny("Authentication required");
        }

        const scope = scopeOf(ctx);
        if (isElevated(scope)) return true;

        if (!isMember(scope)) {
          return deny("Organization membership required");
        }

        if (hasPermissions(scope.orgRoles, permissions)) {
          return true;
        }

        const needed = Object.entries(permissions)
          .map(([r, a]) => `${r}:[${a.join(",")}]`)
          .join(", ");
        return deny(`Missing permissions: ${needed}`);
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
  // Injected logger wins; otherwise arc's namespaced logger (host-controlled,
  // silenceable) — never the global `console`, which bypasses arc's log config.
  const logger = config.logger ?? arcLog("permissions:dynamic");
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
  // org → its cache keys. `invalidateByOrg` matches the DEFAULT key by `orgId::`
  // prefix, but a host-supplied `cache.key(ctx)` need not carry the org, so a
  // prefix scan alone would leave a custom-keyed matrix live until TTL — a
  // revocation gap. This index records every key under the org it was resolved
  // for (known at resolve time), so invalidation finds it regardless of key shape.
  const orgKeyIndex = new Map<string, Set<string>>();
  const maxTrackedKeys = config.cache?.maxEntries ?? 10_000;
  /**
   * Record a key and ENFORCE the cap in the same step.
   *
   * The cap has to live here rather than at the write site: a node that mostly
   * READS a shared cache registers on every hit but may rarely set, so a
   * cap applied only after a `set` never runs and the bookkeeping grows with
   * every distinct org/user/role combination the node has ever seen — unbounded,
   * and outliving the cache entries themselves, which the external store expires
   * on its own schedule. Eviction is insertion-ordered (`Set` iteration order),
   * so the oldest bookkeeping goes first; dropping a key only costs a missed
   * local invalidation for an entry that will still expire by TTL.
   */
  const registerKey = (orgId: string | undefined, key: string): void => {
    trackedKeys.add(key);
    const bucket = orgId ?? "no-org";
    let keys = orgKeyIndex.get(bucket);
    if (!keys) {
      keys = new Set<string>();
      orgKeyIndex.set(bucket, keys);
    }
    keys.add(key);

    if (trackedKeys.size > maxTrackedKeys) {
      const overflow = trackedKeys.size - maxTrackedKeys;
      const iter = trackedKeys.values();
      for (let i = 0; i < overflow; i++) {
        const oldest = iter.next().value;
        if (oldest) forgetKey(oldest);
      }
    }
  };
  const forgetKey = (key: string): void => {
    trackedKeys.delete(key);
    for (const [bucket, keys] of orgKeyIndex) {
      // Drop the bucket once empty — otherwise the org set leaks one entry per
      // organization the node ever served, which is the same unbounded growth
      // one level up.
      if (keys.delete(key) && keys.size === 0) orgKeyIndex.delete(bucket);
    }
  };

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

    // PREFERRED: store-native pattern delete. Every key for an org shares the
    // `${orgId}::` prefix (default AND auto-namespaced custom keys), so one
    // `clear("${orgId}::*")` removes them ALL directly in the shared store —
    // regardless of which process wrote them. This makes revocation immediate,
    // cross-node, and RESTART-SAFE (it does not depend on THIS process's
    // in-memory `orgKeyIndex`, which a restarted node would have lost — the gap a
    // purely process-local index leaves open). Redis adapters map this to
    // SCAN+DEL; MemoryCacheStore glob-matches. We still clear local bookkeeping.
    if (cacheStore.clear) {
      try {
        await cacheStore.clear(`${prefix}*`);
        const keys = orgKeyIndex.get(orgId);
        if (keys) for (const k of keys) trackedKeys.delete(k);
        orgKeyIndex.delete(orgId);
        return;
      } catch (error) {
        logger.warn(
          `[DynamicPermissionMatrix] invalidateByOrg clear('${prefix}*') failed — falling back to per-key delete: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // FALLBACK (store has no `clear`): best-effort per-key delete via the
    // in-process index + a prefix scan of tracked keys. Correct for a single
    // long-lived process; keys written by a SINCE-RESTARTED node without pattern
    // support persist until TTL (documented — provide a `clear`-capable store,
    // e.g. Redis, for a hard distributed-revocation guarantee).
    const toDelete = new Set<string>(orgKeyIndex.get(orgId) ?? []);
    for (const key of trackedKeys) {
      if (key.startsWith(prefix)) toDelete.add(key);
    }
    for (const key of toDelete) {
      try {
        await cacheStore.delete(key);
        forgetKey(key);
      } catch (error) {
        logger.warn(
          `[DynamicPermissionMatrix] invalidateByOrg delete failed for '${key}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    orgKeyIndex.delete(orgId);
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

    // Custom keys are AUTO-NAMESPACED by org + normalized org-roles — the same
    // isolation the default key guarantees. A host `cache.key(ctx)` that returns
    // a bare `user:<id>` must NOT let org B read org A's cached matrix (both admin
    // in A and B, different matrices), nor serve a stale matrix after the caller's
    // roles change. The caller only needs to encode dimensions BEYOND org+roles.
    const customKey = config.cache?.key?.(ctx);
    const cacheKey = customKey
      ? `${orgId ?? "no-org"}::${(orgRoles ?? []).slice().sort().join(",")}::${customKey}`
      : buildDefaultCacheKey(ctx, orgId, orgRoles);

    if (!cacheKey) {
      return config.resolveRolePermissions(ctx);
    }

    try {
      const hit = await cacheStore.get(cacheKey);
      if (hit) {
        // Register on HIT too: a process (node) that only ever READS a
        // shared/distributed cache would otherwise never track the key and so
        // could not evict it on an org invalidation — revoked access would
        // linger until TTL. Registration is idempotent.
        registerKey(orgId, cacheKey);
        return hit;
      }
    } catch (error) {
      logger.warn(
        `[DynamicPermissionMatrix] Cache get failed for '${cacheKey}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const value = await config.resolveRolePermissions(ctx);

    try {
      await cacheStore.set(cacheKey, value, cacheTtlSeconds);
      registerKey(orgId, cacheKey);
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
        return deny("Authentication required");
      }

      const scope = scopeOf(ctx);
      if (isElevated(scope)) return true;

      if (!isMember(scope)) {
        return deny("Organization membership required");
      }

      const orgRoles = scope.orgRoles;
      if (orgRoles.length === 0) {
        return deny("Not a member of this organization");
      }

      let matrix: Record<string, Record<string, readonly string[]>>;
      try {
        matrix = await resolveMatrix(ctx, scope.organizationId, orgRoles);
      } catch (error) {
        // Log the real cause internally; return a GENERIC denial. Echoing the
        // resolver's exception text (DB errors, connection strings, stack hints)
        // into the 4xx body leaks internals to the caller. Fail-closed either way.
        logger.warn(
          `[DynamicPermissionMatrix] matrix resolution failed for org '${scope.organizationId ?? "?"}': ${error instanceof Error ? error.message : String(error)}`,
        );
        return deny("Permission policy is temporarily unavailable");
      }

      for (const [resource, actions] of Object.entries(required)) {
        for (const action of actions) {
          const granted = orgRoles.some((role) => roleAllows(matrix, role, resource, action));
          if (!granted) {
            return deny(`Missing permission: ${resource}:${action}`);
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
          orgKeyIndex.clear();
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
      orgKeyIndex.clear();
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
