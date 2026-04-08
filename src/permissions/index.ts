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

// Framework-internal primitives — exported from the barrel because the
// package has `sideEffects: false`, so ESM tree-shaking eliminates unused
// re-exports for end users who don't import them. Internal call sites
// (createCrudRouter, createActionRouter, MCP resourceToTools) import these
// directly from "./applyPermissionResult.js" to skip the barrel entirely.
// End users almost never need these — returning a PermissionResult from a
// permission check is enough; Arc applies it automatically.
export { applyPermissionResult, normalizePermissionResult } from "./applyPermissionResult.js";
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
  getRequestScope as getScope,
  getScopeContext,
  getScopeContextMap,
  getUserId as getScopeUserId,
  getServiceScopes,
  getTeamId,
  hasOrgAccess,
  isElevated,
  isMember,
  isOrgInScope,
  isService,
} from "../scope/types.js";
import type { PermissionCheck, PermissionContext, PermissionResult } from "./types.js";

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Normalize a `string | [readonly string[]]` rest-args tuple into a single
 * `readonly string[]`. Lets a permission helper accept BOTH variadic and
 * array call shapes from the same overload signature without each helper
 * re-implementing the same ternary.
 *
 * Used by `requireOrgRole`, `requireServiceScope`, etc. **Not** used by
 * `requireRoles` — that helper has a richer overload signature with an
 * options object and stays on its own normalization path.
 *
 * @example
 * ```typescript
 * function requireFoo(...args: string[] | [readonly string[]]) {
 *   const items = normalizeVariadicOrArray(args);
 *   // items is always readonly string[]
 * }
 * requireFoo('a', 'b', 'c');
 * requireFoo(['a', 'b', 'c']);
 * ```
 */
function normalizeVariadicOrArray(args: string[] | [readonly string[]]): readonly string[] {
  return Array.isArray(args[0]) ? args[0] : (args as string[]);
}

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
/**
 * Require one of the specified roles. Checks BOTH platform roles
 * (`user.role`) AND organization roles (`scope.orgRoles`) by default —
 * passing in either layer grants access. Elevated scope always passes.
 *
 * Accepts EITHER variadic strings OR a single readonly array — both forms
 * produce identical behavior. Use whichever reads better at the call site.
 *
 * @example
 * ```typescript
 * requireRoles('admin')                       // single role, variadic
 * requireRoles('admin', 'editor')             // multiple roles, variadic
 * requireRoles(['admin', 'editor'])           // array form
 * requireRoles(['admin'], { bypassRoles: ['superadmin'] })   // with options
 * requireRoles(['admin'], { includeOrgRoles: false })        // platform-only
 * ```
 *
 * **2.7.1 BREAKING CHANGE:** `includeOrgRoles` now defaults to `true`. The
 * old default (`false`, platform-only) was a footgun for the common case of
 * Better Auth's organization plugin where roles like 'admin' are assigned at
 * the org level. To restore the old behavior explicitly, pass
 * `{ includeOrgRoles: false }`.
 *
 * For org-only role checks, prefer `requireOrgRole('admin')`.
 */
export function requireRoles(role: string, ...rest: string[]): PermissionCheck;
export function requireRoles(
  roles: readonly string[],
  options?: {
    bypassRoles?: readonly string[];
    /**
     * Also check org membership roles (`scope.orgRoles`) when in org context.
     * Default: `true` (changed in 2.7.1).
     *
     * Set to `false` to restore the pre-2.7.1 behavior of checking only
     * platform roles (`user.role`). For org-only role checks, prefer
     * `requireOrgRole('admin')` instead.
     */
    includeOrgRoles?: boolean;
  },
): PermissionCheck;
export function requireRoles(
  rolesOrFirst: string | readonly string[],
  optionsOrSecond?:
    | string
    | {
        bypassRoles?: readonly string[];
        includeOrgRoles?: boolean;
      },
  ...rest: string[]
): PermissionCheck {
  // Normalize the two call shapes:
  //   requireRoles('admin', 'editor', ...)         → variadic
  //   requireRoles(['admin', 'editor'], { ... })   → array + options
  let roles: readonly string[];
  let options: { bypassRoles?: readonly string[]; includeOrgRoles?: boolean } | undefined;

  if (typeof rolesOrFirst === "string") {
    // Variadic form — collect all positional string args
    roles = [
      rolesOrFirst,
      ...(typeof optionsOrSecond === "string" ? [optionsOrSecond] : []),
      ...rest,
    ];
    options = undefined;
  } else {
    roles = rolesOrFirst;
    options = optionsOrSecond && typeof optionsOrSecond === "object" ? optionsOrSecond : undefined;
  }

  // 2.7.1: includeOrgRoles defaults to TRUE — checks both platform and org
  // roles by default. Pass `{ includeOrgRoles: false }` to opt out.
  const includeOrgRoles = options?.includeOrgRoles ?? true;

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

    // Check org roles when in org context (default behavior in 2.7.1+)
    if (includeOrgRoles) {
      const scope = getScope(ctx.request);
      if (isElevated(scope)) return true;
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
 * **Alias of `requireRoles()`** — checks both platform roles AND org roles.
 *
 * Since 2.7.1, `requireRoles()` defaults to `includeOrgRoles: true`, which
 * means `roles('admin')` and `requireRoles('admin')` are now functionally
 * identical. This helper is preserved for backwards compatibility and for
 * call sites that prefer the shorter `roles()` name.
 *
 * **For new code, prefer `requireRoles()`** — it's the canonical name and
 * matches the rest of the `requireXxx()` family (`requireAuth`, `requireOwnership`,
 * `requireOrgRole`, etc.).
 *
 * For platform-only checks: `requireRoles(['admin'], { includeOrgRoles: false })`
 * For org-only checks: `requireOrgRole('admin')`
 *
 * @example
 * ```typescript
 * // These are identical:
 * roles('admin', 'editor')
 * requireRoles('admin', 'editor')
 * requireRoles(['admin', 'editor'])
 * ```
 */
export function roles(...args: string[] | [readonly string[]]): PermissionCheck {
  const roleList = normalizeVariadicOrArray(args);

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
 * Combine multiple checks - ALL must pass (AND logic).
 *
 * Each child runs against the **accumulated** state of previous children:
 *   - `filters` from earlier children are merged into the next child's
 *     `_policyFilters` (so e.g. `requireOwnership` sees row-level scoping)
 *   - `scope` from earlier children is installed on the request before the
 *     next child runs (so e.g. `requireOrgMembership` after `requireApiKey`
 *     sees the service scope from the API key check)
 *
 * The final returned `PermissionResult` carries both the merged `filters` AND
 * the merged `scope`, so the outer middleware's `applyPermissionResult` call
 * sees the same end-state.
 *
 * @example
 * ```typescript
 * // CRUD permissions composed across roles + ownership
 * permissions: {
 *   update: allOf(
 *     requireAuth(),
 *     requireRoles(['editor']),
 *     requireOwnership('createdBy')
 *   ),
 * }
 *
 * // Custom auth + org membership — first check installs the scope,
 * // second check reads it.
 * permissions: {
 *   list: allOf(requireApiKey(), requireOrgMembership()),
 * }
 * ```
 */
export function allOf(...checks: PermissionCheck[]): PermissionCheck {
  return async (ctx) => {
    let mergedFilters: Record<string, unknown> = {};
    let installedScope: RequestScope | undefined;

    // Snapshot the request's pre-existing _policyFilters / scope so we can
    // restore on failure (avoid leaking partial state into the request when
    // a later child denies).
    const sink = ctx.request as FastifyRequest & {
      _policyFilters?: Record<string, unknown>;
      scope?: RequestScope;
    };
    const originalFilters = sink._policyFilters;
    const originalScope = sink.scope;

    try {
      for (const check of checks) {
        const result = await check(ctx);
        const normalized: PermissionResult =
          typeof result === "boolean" ? { granted: result } : result;

        if (!normalized.granted) {
          // Restore request state before bailing — partial allOf() runs must
          // not leak filters/scope from earlier children that won't be honored.
          sink._policyFilters = originalFilters;
          sink.scope = originalScope;
          return normalized;
        }

        // Merge filters and apply them to the request so the NEXT child sees
        // the accumulated row-level filter (mirrors how middleware would have
        // applied them between two separate permission checks).
        if (normalized.filters) {
          mergedFilters = { ...mergedFilters, ...normalized.filters };
          sink._policyFilters = {
            ...(sink._policyFilters ?? {}),
            ...normalized.filters,
          };
        }

        // Install scope so the next child reads the augmented context.
        // Mirrors `applyPermissionResult`'s "don't downgrade" rule: only
        // install when the current scope is absent or `public`.
        if (normalized.scope) {
          const current = sink.scope;
          if (!current || current.kind === "public") {
            sink.scope = normalized.scope;
            installedScope = normalized.scope;
          } else if (!installedScope) {
            // Even if we don't write to the request (because something more
            // authoritative is already there), still surface the scope on the
            // returned result so callers/audits can see what allOf produced.
            installedScope = normalized.scope;
          }
        }
      }
    } catch (err) {
      // Restore request state on any thrown error — same reasoning as the
      // denial path: partial allOf() runs leave no side effects.
      sink._policyFilters = originalFilters;
      sink.scope = originalScope;
      throw err;
    }

    return {
      granted: true,
      filters: Object.keys(mergedFilters).length > 0 ? mergedFilters : undefined,
      scope: installedScope,
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
// Org-Bound Helpers
// ----------------------------------------------------------------------------
// Helpers that gate routes by an organization context. All read
// `request.scope` set by an auth adapter (Better Auth bridge / JWT custom
// auth / API-key check returning a `PermissionResult.scope`).
// ============================================================================

/**
 * Require an org-bound caller. Grants access for any scope kind that
 * carries org context: `member` (human user with org membership), `service`
 * (API key bound to an org), or `elevated` (platform admin). Denies for
 * `public` and `authenticated` scopes (no org context).
 *
 * This is the canonical "is the caller acting inside an org" check, and the
 * usual partner for `multiTenantPreset` — if a route is multi-tenant
 * filtered, you almost always want this gate too.
 *
 * Reads `request.scope` set by auth adapters or by upstream permission
 * checks via `PermissionResult.scope` (e.g. a custom `requireApiKey()`).
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: requireOrgMembership(),
 *   get: requireOrgMembership(),
 *
 *   // Composed with an OAuth-style scope check for API-key callers
 *   create: allOf(requireOrgMembership(), requireServiceScope('jobs:write')),
 * }
 * ```
 */
export function requireOrgMembership<TDoc = Record<string, unknown>>(): PermissionCheck<TDoc> {
  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

    // 2.7.0: any scope kind with org-access semantics passes — member,
    // service (API key bound to one org), and elevated (platform admin,
    // org optional). Type system guarantees member/service carry an
    // organizationId; elevated-without-org is the documented cross-org
    // admin bypass and is intentionally allowed here.
    //
    // Service scopes have no `ctx.user` — that's fine, the user-presence
    // check below only fires for non-org scopes (public/authenticated).
    if (hasOrgAccess(scope)) return true;

    // Non-org scopes: surface a message that matches the user's mental model.
    //   - public → "Authentication required"
    //   - authenticated without org → "Organization membership required"
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }
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
 * **Service scopes (API keys) always fail this check** — services don't
 * carry user-style org roles, only OAuth-style `scopes` strings. For routes
 * that should accept BOTH human admins AND API keys, compose explicitly:
 *
 * ```typescript
 * permissions: {
 *   create: anyOf(
 *     requireOrgRole('admin'),                       // human path
 *     requireServiceScope('jobs:write'),             // machine path
 *   ),
 * }
 * ```
 *
 * This separation is intentional — implicit "API key bypasses role checks"
 * is the kind of footgun that ships data breaches. Services must opt into
 * specific scopes the same way OAuth clients do.
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
  // Accepts both `requireOrgRole('admin', 'owner')` and `requireOrgRole(['admin', 'owner'])`
  const roles = normalizeVariadicOrArray(args);

  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

    // Elevated bypass — platform admin can act regardless of org role
    if (isElevated(scope)) return true;

    // Service scope (API key) — explicitly deny with a guidance reason.
    // Services have OAuth-style `scopes`, not user-style `orgRoles`.
    // Compose with `requireServiceScope(...)` via `anyOf()` for mixed routes.
    if (isService(scope)) {
      return {
        granted: false,
        reason:
          "Service scopes (API keys) cannot satisfy requireOrgRole. " +
          "Use requireServiceScope(...) for machine identities, or compose " +
          "with anyOf(requireOrgRole(...), requireServiceScope(...)) to accept both.",
      };
    }

    // Human path — require user + member scope
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

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

// ============================================================================
// Service / API Key Scopes
// ----------------------------------------------------------------------------
// OAuth-style scope strings for machine identities (API keys, service
// accounts). Companion to `requireOrgRole` for the human path — see the
// "mixed routes" pattern in each helper's JSDoc.
// ============================================================================

/**
 * Require specific OAuth-style scope strings on a service (API key) identity.
 *
 * Reads `request.scope.scopes` — only populated when the scope kind is
 * `service`. Mirrors how OAuth 2.0 / Better Auth's apiKey plugin / API
 * gateways express machine permissions: a comma- or array-encoded list of
 * scope strings like `'jobs:read'`, `'jobs:write'`, `'memories:*'`.
 *
 * **Pass behavior:**
 * - `service` scope where `scopes` contains ANY of the required strings → grant
 * - `elevated` scope (platform admin) → grant
 * - Anything else → deny with a clear reason
 *
 * Notably this does **not** grant for `member` scopes — humans go through
 * `requireOrgRole`. For routes that should accept both, compose with `anyOf`:
 *
 * ```typescript
 * permissions: {
 *   create: anyOf(
 *     requireOrgRole('admin'),
 *     requireServiceScope('jobs:write'),
 *   ),
 * }
 * ```
 *
 * @param scopes - Required scope strings (caller needs at least one)
 *
 * @example
 * ```typescript
 * // Variadic
 * requireServiceScope('jobs:write')
 * requireServiceScope('jobs:read', 'jobs:write')
 *
 * // Array
 * requireServiceScope(['jobs:read', 'jobs:write'])
 *
 * // Composed with org membership for org-scoped API keys
 * permissions: {
 *   list: allOf(requireOrgMembership(), requireServiceScope('jobs:read')),
 *   create: allOf(requireOrgMembership(), requireServiceScope('jobs:write')),
 * }
 * ```
 */
export function requireServiceScope<TDoc = Record<string, unknown>>(
  ...args: string[] | [readonly string[]]
): PermissionCheck<TDoc> {
  // Accepts both `requireServiceScope('jobs:write')` and `requireServiceScope(['jobs:write'])`
  const required = normalizeVariadicOrArray(args);

  if (required.length === 0) {
    throw new Error(
      "requireServiceScope() requires at least one scope string (e.g. requireServiceScope('jobs:write'))",
    );
  }

  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

    // Elevated bypass — platform admin can act regardless of service scopes
    if (isElevated(scope)) return true;

    if (!isService(scope)) {
      return {
        granted: false,
        reason:
          "Service identity required (API key). " +
          "For human users, use requireOrgRole(...) or compose with " +
          "anyOf(requireOrgRole(...), requireServiceScope(...)).",
      };
    }

    const granted = getServiceScopes(scope);
    if (required.some((r) => granted.includes(r))) {
      return true;
    }

    return {
      granted: false,
      reason: `Required service scopes: ${required.join(", ")} (granted: ${granted.length > 0 ? granted.join(", ") : "none"})`,
    };
  };
  // Tag for introspection / OpenAPI docs (parallels _orgRoles on requireOrgRole)
  check._serviceScopes = required;
  return check;
}

// ============================================================================
// Scope Context (custom tenancy dimensions)
// ----------------------------------------------------------------------------
// Helpers for app-defined scope dimensions (branch, project, department,
// region, workspace, …) that arc itself doesn't model. Auth function
// populates `scope.context`; routes gate via `requireScopeContext`;
// `multiTenantPreset({ tenantFields })` filters by them.
// ============================================================================

/**
 * Require app-defined scope context dimensions (branch, project, department,
 * region, workspace, etc.) on the current request.
 *
 * Reads `request.scope.context` (a `Readonly<Record<string, string>>` slot
 * available on `member`, `service`, and `elevated` scope kinds). Arc takes
 * no position on what dimensions you use — you set them, you check them.
 *
 * **Three call shapes:**
 *
 * ```typescript
 * // 1. Presence check — key must exist on scope.context
 * requireScopeContext('branchId')
 *
 * // 2. Value match — key must equal a specific string
 * requireScopeContext('branchId', 'eng-paris')
 *
 * // 3. Multi-key (object form, AND semantics) — every key must match
 * requireScopeContext({ branchId: 'eng-paris', projectId: 'p-123' })
 * requireScopeContext({ region: 'eu', branchId: undefined })  // 'undefined' = presence-only for that key
 * ```
 *
 * **Pass behavior:**
 * - All required keys present (and matching values when specified) → grant
 * - `elevated` scope (platform admin) → grant unconditionally (cross-context bypass)
 * - Any required key missing or mismatched → deny with a clear reason
 * - Scope kind without context support (`public`, `authenticated`) → deny
 *
 * Pairs with `multiTenantPreset({ tenantFields: [...] })` for row-level
 * filtering on the same dimensions.
 *
 * @example
 * ```typescript
 * permissions: {
 *   // Branch-scoped CRUD — caller must have branchId in their scope context
 *   list: allOf(requireOrgMembership(), requireScopeContext('branchId')),
 *
 *   // Project admin — caller must have BOTH project context AND admin role
 *   delete: allOf(requireOrgRole('admin'), requireScopeContext('projectId')),
 *
 *   // Region-locked endpoint
 *   euOnly: requireScopeContext('region', 'eu'),
 * }
 * ```
 */
export function requireScopeContext<TDoc = Record<string, unknown>>(
  keyOrMap: string | Record<string, string | undefined>,
  value?: string,
): PermissionCheck<TDoc> {
  // Normalize the three call shapes into a single { key: expectedValue|undefined } map.
  // `undefined` means "presence-only" for that key.
  let required: Record<string, string | undefined>;

  if (typeof keyOrMap === "string") {
    required = { [keyOrMap]: value };
  } else if (keyOrMap && typeof keyOrMap === "object") {
    required = keyOrMap;
  } else {
    throw new Error(
      "requireScopeContext() requires a key (string), key+value, or { key: value } map",
    );
  }

  const requiredKeys = Object.keys(required);
  if (requiredKeys.length === 0) {
    throw new Error(
      "requireScopeContext() requires at least one key (e.g. requireScopeContext('branchId'))",
    );
  }

  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

    // Elevated bypass — platform admin can act regardless of context dimensions
    if (isElevated(scope)) return true;

    const ctxMap = getScopeContextMap(scope);
    if (!ctxMap) {
      return {
        granted: false,
        reason:
          "Scope context required (member, service, or elevated scope). " +
          "Populate request.scope.context in your auth function.",
      };
    }

    // Walk every required key — fail closed on the first mismatch
    for (const key of requiredKeys) {
      const expected = required[key];
      const actual = getScopeContext(scope, key);
      if (actual === undefined) {
        return {
          granted: false,
          reason: `Required scope context key "${key}" is missing`,
        };
      }
      if (expected !== undefined && actual !== expected) {
        return {
          granted: false,
          reason: `Required scope context "${key}" must equal "${expected}" (got "${actual}")`,
        };
      }
    }

    return true;
  };

  // Tag for introspection / OpenAPI docs (parallels _orgRoles, _serviceScopes)
  check._scopeContext = required;
  return check;
}

// ============================================================================
// Org Hierarchy
// ----------------------------------------------------------------------------
// Parent-child organization checks. Auth function pre-loads
// `scope.ancestorOrgIds`; routes opt in via `requireOrgInScope`. No
// automatic permission inheritance — every check is explicit.
// ============================================================================

/**
 * Require that the caller's scope grants access to a target organization
 * — either the current org or one of its ancestors (`scope.ancestorOrgIds`).
 *
 * Designed for parent-child organization hierarchies (holding company →
 * subsidiary → branch, MSP → managed tenants, white-label parent → child
 * accounts) where some routes need to accept "this org OR any org I have
 * access to via the chain". Arc takes no position on the source of the
 * chain — your auth function loads `ancestorOrgIds` from your own data
 * model. There's no automatic inheritance: every route opts in explicitly.
 *
 * **Two call shapes:**
 *
 * ```typescript
 * // Static target — rare, used when one route only ever acts on one org
 * requireOrgInScope('acme-holding')
 *
 * // Dynamic target — extracted from request params/body/headers per call
 * requireOrgInScope((ctx) => ctx.request.params.orgId)
 * requireOrgInScope((ctx) => ctx.request.body?.organizationId)
 * ```
 *
 * **Pass behavior:**
 * - Target equals `scope.organizationId` → grant
 * - Target appears in `scope.ancestorOrgIds` → grant
 * - `elevated` scope → grant unconditionally (cross-org admin bypass)
 * - Target is undefined (extractor returned nothing) → deny with reason
 * - Anything else → deny with target name in reason
 *
 * @example
 * ```typescript
 * // /orgs/:orgId/jobs — caller can act on any org in their hierarchy chain
 * permissions: {
 *   list: requireOrgInScope((ctx) => ctx.request.params.orgId),
 *   create: allOf(
 *     requireOrgInScope((ctx) => ctx.request.body?.organizationId),
 *     requireOrgRole('admin'),
 *   ),
 * }
 * ```
 */
export function requireOrgInScope<TDoc = Record<string, unknown>>(
  target: string | ((ctx: PermissionContext<TDoc>) => string | undefined),
): PermissionCheck<TDoc> {
  if (target === undefined || target === null) {
    throw new Error(
      "requireOrgInScope() requires a target org id (string) or an extractor function",
    );
  }

  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

    // Elevated bypass — platform admin acts cross-org regardless of chain
    if (isElevated(scope)) return true;

    // Resolve the target org id (static or dynamic)
    const targetOrgId = typeof target === "function" ? target(ctx) : target;
    if (!targetOrgId) {
      return {
        granted: false,
        reason: "requireOrgInScope: target org id could not be resolved from the request",
      };
    }

    if (isOrgInScope(scope, targetOrgId)) return true;

    return {
      granted: false,
      reason: `Target organization "${targetOrgId}" is not in the caller's org hierarchy`,
    };
  };

  // Tag for introspection (parallels _orgRoles, _serviceScopes, _scopeContext)
  check._orgInScopeTarget = target;
  return check;
}

// ============================================================================
// Permission Matrices
// ----------------------------------------------------------------------------
// Higher-level role × resource × action mapping. Static
// (`createOrgPermissions`) for compile-time-known matrices, dynamic
// (`createDynamicPermissionMatrix`) for runtime-resolved ones with
// optional caching and event-based invalidation.
// ============================================================================

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
