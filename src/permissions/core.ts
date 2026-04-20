/**
 * Permission Core — universal permission primitives.
 *
 * Auth/role/ownership checks and the combinators (`allOf`, `anyOf`, `not`,
 * `when`, `denyAll`) that compose them. Scope-bound checks live in
 * `./scope.js`; the dynamic matrix lives in `./dynamic.js`.
 */

import type { FastifyRequest } from "fastify";
import type { RequestScope } from "../scope/types.js";
import {
  getRequestScope as getScope,
  getUserId as getScopeUserId,
  isElevated,
  isMember,
} from "../scope/types.js";
import type { PermissionCheck, PermissionContext, PermissionResult } from "./types.js";
import { getUserRoles } from "./types.js";

/**
 * Normalize a `string | [readonly string[]]` rest-args tuple into a single
 * `readonly string[]`. Lets a permission helper accept BOTH variadic and
 * array call shapes from one overload signature.
 *
 * Used by `requireOrgRole`, `requireServiceScope`, etc. **Not** used by
 * `requireRoles` — that helper has a richer overload signature with an
 * options object and stays on its own normalization path.
 */
export function normalizeVariadicOrArray(args: string[] | [readonly string[]]): readonly string[] {
  return Array.isArray(args[0]) ? args[0] : (args as string[]);
}

/**
 * Allow public access (no authentication required).
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
  check._isPublic = true;
  return check;
}

/**
 * Require authentication (any authenticated user).
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
 * Require one of the specified roles. Checks BOTH platform roles
 * (`user.role`) AND organization roles (`scope.orgRoles`) by default —
 * passing in either layer grants access. Elevated scope always passes.
 *
 * Accepts EITHER variadic strings OR a single readonly array — both forms
 * produce identical behavior.
 *
 * @example
 * ```typescript
 * requireRoles('admin')
 * requireRoles('admin', 'editor')
 * requireRoles(['admin', 'editor'])
 * requireRoles(['admin'], { bypassRoles: ['superadmin'] })
 * requireRoles(['admin'], { includeOrgRoles: false })  // platform-only
 * ```
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
     * Default: `true`. Set to `false` to check only platform roles.
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
  let roles: readonly string[];
  let options: { bypassRoles?: readonly string[]; includeOrgRoles?: boolean } | undefined;

  if (typeof rolesOrFirst === "string") {
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

  const includeOrgRoles = options?.includeOrgRoles ?? true;

  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

    const userRoles = getUserRoles(ctx.user);

    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    if (roles.some((r) => userRoles.includes(r))) {
      return true;
    }

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
 * Short-form alias of `requireRoles()`. Identical behavior — checks both
 * platform roles AND org roles. Prefer `requireRoles` for new code; this
 * exists for call sites that want a terser name.
 */
export function roles(...args: string[] | [readonly string[]]): PermissionCheck {
  const roleList = normalizeVariadicOrArray(args);

  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return { granted: false, reason: "Authentication required" };
    }

    const userRoles = getUserRoles(ctx.user);
    if (roleList.some((r) => userRoles.includes(r))) {
      return true;
    }

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
 * Require resource ownership. Returns filters to scope queries to the
 * caller's owned resources.
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

    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

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
 * Combine multiple checks — ALL must pass (AND logic).
 *
 * Each child runs against the **accumulated** state of previous children:
 *   - `filters` from earlier children merge into the next child's `_policyFilters`
 *   - `scope` from earlier children installs on the request before the next child runs
 *
 * The final result carries both merged `filters` and merged `scope`.
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: allOf(requireAuth(), requireRoles(['editor']), requireOwnership('createdBy')),
 *   list: allOf(requireApiKey(), requireOrgMembership()),
 * }
 * ```
 */
export function allOf(...checks: PermissionCheck[]): PermissionCheck {
  return async (ctx) => {
    let mergedFilters: Record<string, unknown> = {};
    let installedScope: RequestScope | undefined;

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
          sink._policyFilters = originalFilters;
          sink.scope = originalScope;
          return normalized;
        }

        if (normalized.filters) {
          mergedFilters = { ...mergedFilters, ...normalized.filters };
          sink._policyFilters = {
            ...(sink._policyFilters ?? {}),
            ...normalized.filters,
          };
        }

        if (normalized.scope) {
          const current = sink.scope;
          if (!current || current.kind === "public") {
            sink.scope = normalized.scope;
            installedScope = normalized.scope;
          } else if (!installedScope) {
            installedScope = normalized.scope;
          }
        }
      }
    } catch (err) {
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
 * Combine multiple checks — ANY must pass (OR logic).
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: anyOf(requireRoles(['admin']), requireOwnership('createdBy')),
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
 * Invert a permission check. Grants when the wrapped check denies, denies
 * when the wrapped check grants. Useful for "block if X" patterns —
 * e.g. `not(requireRoles(['guest']))` to deny guest access.
 *
 * NOTE: filters and scope from the wrapped check are intentionally
 * discarded — an inverted check has no row-level meaning.
 *
 * @example
 * ```typescript
 * permissions: {
 *   internalApi: not(requireRoles(['external'])),
 *   adminUI: allOf(requireAuth(), not(requireRoles(['readonly']))),
 * }
 * ```
 */
export function not(check: PermissionCheck, reason = "Access denied"): PermissionCheck {
  return async (ctx) => {
    const result = await check(ctx);
    const normalized: PermissionResult = typeof result === "boolean" ? { granted: result } : result;
    return normalized.granted ? { granted: false, reason } : true;
  };
}

/**
 * Deny all access.
 *
 * @example
 * ```typescript
 * permissions: { delete: denyAll('Deletion not allowed') }
 * ```
 */
export function denyAll(reason = "Access denied"): PermissionCheck {
  return () => ({ granted: false, reason });
}

/**
 * Dynamic permission based on a condition function.
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
