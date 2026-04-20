/**
 * Permission Scope — checks bound to RequestScope.
 *
 * All read `request.scope` populated by an auth adapter (Better Auth bridge,
 * JWT custom auth, or an upstream permission check returning
 * `PermissionResult.scope`).
 */

import {
  getRequestScope as getScope,
  getScopeContext,
  getScopeContextMap,
  getServiceScopes,
  getTeamId,
  hasOrgAccess,
  isElevated,
  isMember,
  isOrgInScope,
  isService,
} from "../scope/types.js";
import { normalizeVariadicOrArray } from "./core.js";
import type { PermissionCheck, PermissionContext } from "./types.js";

/**
 * Require an org-bound caller. Grants for `member`, `service`, and
 * `elevated` scopes (anything with org context). Denies `public` and
 * `authenticated` (no org context).
 *
 * Canonical "is the caller acting inside an org" check. Usual partner for
 * `multiTenantPreset` — if a route filters by tenant, you almost always
 * want this gate too.
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: requireOrgMembership(),
 *   create: allOf(requireOrgMembership(), requireServiceScope('jobs:write')),
 * }
 * ```
 */
export function requireOrgMembership<TDoc = Record<string, unknown>>(): PermissionCheck<TDoc> {
  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);
    if (hasOrgAccess(scope)) return true;

    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }
    return { granted: false, reason: "Organization membership required" };
  };
  check._orgPermission = "membership";
  return check;
}

/**
 * Require specific org-level roles. Reads `request.scope.orgRoles`.
 * Elevated scope always passes (platform admin bypass).
 *
 * **Service scopes (API keys) always fail this check** — services don't
 * carry user-style org roles, only OAuth-style `scopes` strings. For
 * routes that should accept BOTH human admins AND API keys, compose with
 * `anyOf(requireOrgRole(...), requireServiceScope(...))`. The implicit
 * "API key bypasses role check" path is intentionally NOT supported —
 * it's the kind of footgun that ships data breaches.
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
  const roles = normalizeVariadicOrArray(args);

  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

    if (isElevated(scope)) return true;

    if (isService(scope)) {
      return {
        granted: false,
        reason:
          "Service scopes (API keys) cannot satisfy requireOrgRole. " +
          "Use requireServiceScope(...) for machine identities, or compose " +
          "with anyOf(requireOrgRole(...), requireServiceScope(...)) to accept both.",
      };
    }

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

/**
 * Require specific OAuth-style scope strings on a service (API key) identity.
 * Reads `request.scope.scopes` (only present when `scope.kind === 'service'`).
 *
 * **Pass behavior:**
 * - `service` scope where `scopes` contains ANY required string → grant
 * - `elevated` scope → grant
 * - Anything else → deny with a clear reason
 *
 * Does **not** grant for `member` scopes — humans go through `requireOrgRole`.
 * For routes that should accept both, compose with `anyOf`.
 *
 * @example
 * ```typescript
 * requireServiceScope('jobs:write')
 * requireServiceScope('jobs:read', 'jobs:write')
 * requireServiceScope(['jobs:read', 'jobs:write'])
 *
 * permissions: {
 *   list: allOf(requireOrgMembership(), requireServiceScope('jobs:read')),
 * }
 * ```
 */
export function requireServiceScope<TDoc = Record<string, unknown>>(
  ...args: string[] | [readonly string[]]
): PermissionCheck<TDoc> {
  const required = normalizeVariadicOrArray(args);

  if (required.length === 0) {
    throw new Error(
      "requireServiceScope() requires at least one scope string (e.g. requireServiceScope('jobs:write'))",
    );
  }

  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

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
  check._serviceScopes = required;
  return check;
}

/**
 * Require app-defined scope context dimensions (branch, project, region,
 * workspace, …) on the request. Arc takes no position on what dimensions
 * you use — your auth function populates `scope.context`, your routes
 * gate on it.
 *
 * **Three call shapes:**
 * ```typescript
 * requireScopeContext('branchId')                                 // presence only
 * requireScopeContext('branchId', 'eng-paris')                    // value match
 * requireScopeContext({ branchId: 'eng-paris', projectId: 'p-1' }) // multi-key (AND)
 * requireScopeContext({ region: 'eu', branchId: undefined })      // mixed
 * ```
 *
 * **Pass behavior:** all required keys present (and matching when
 * specified) → grant. `elevated` scope grants unconditionally.
 *
 * @example
 * ```typescript
 * permissions: {
 *   list: allOf(requireOrgMembership(), requireScopeContext('branchId')),
 *   euOnly: requireScopeContext('region', 'eu'),
 * }
 * ```
 */
export function requireScopeContext<TDoc = Record<string, unknown>>(
  keyOrMap: string | Record<string, string | undefined>,
  value?: string,
): PermissionCheck<TDoc> {
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

  check._scopeContext = required;
  return check;
}

/**
 * Require that the caller's scope grants access to a target organization
 * — either the current org or one of its ancestors (`scope.ancestorOrgIds`).
 *
 * For parent-child organization hierarchies (holding → subsidiary → branch,
 * MSP → tenant, white-label parent → child). Auth function pre-loads
 * `ancestorOrgIds`; routes opt in explicitly. No automatic inheritance.
 *
 * **Two call shapes:**
 * ```typescript
 * requireOrgInScope('acme-holding')                          // static
 * requireOrgInScope((ctx) => ctx.request.params.orgId)       // dynamic
 * ```
 *
 * `elevated` scope grants unconditionally (cross-org bypass).
 *
 * @example
 * ```typescript
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

    if (isElevated(scope)) return true;

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

  check._orgInScopeTarget = target;
  return check;
}

/**
 * Require membership in the active team. User must be authenticated, a
 * member of the active org, AND have an active team. Better Auth teams
 * are flat member groups (no team-level roles). Reads `request.scope.teamId`.
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
