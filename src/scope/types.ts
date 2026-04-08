/**
 * Request Scope — The One Standard
 *
 * Discriminated union representing the access context of every request.
 * Replaces scattered orgScope/orgRoles/organizationId/bypassRoles.
 *
 * Set once by auth adapters, read everywhere by permissions/presets/guards.
 *
 * @example
 * ```typescript
 * // In a permission check
 * const scope = request.scope;
 * if (isElevated(scope)) return true;
 * if (isMember(scope) && scope.orgRoles.includes('admin')) return true;
 *
 * // Get user identity from scope
 * const userId = getUserId(scope);
 * const globalRoles = getUserRoles(scope);
 * ```
 */

// ============================================================================
// Core Type
// ============================================================================

/**
 * Request scope — 5 kinds, no ambiguity.
 *
 * | Kind          | Meaning                                          |
 * |---------------|--------------------------------------------------|
 * | public        | No authentication                                |
 * | authenticated | Logged-in user, no org context                   |
 * | member        | User in an org with specific roles               |
 * | service       | Machine-to-machine (API key, service account)    |
 * | elevated      | Platform admin, explicit elevation               |
 *
 * **Identity fields by kind:**
 * - `userId` / `userRoles` — available on `authenticated`, `member`, `elevated` (a real human)
 * - `clientId` — available on `service` (a machine identity, NOT a user)
 * - `organizationId` — required on `member` and `service`, optional on `elevated`
 * - `orgRoles` — org-level roles, only on `member` (from membership records)
 * - `scopes` — optional OAuth-style scope strings on `service` (e.g. `['jobs:write', 'memories:read']`)
 *
 * Use `getUserId(scope)` / `getClientId(scope)` / `getOrgId(scope)` instead of
 * narrowing manually — helpers return `undefined` when the field isn't present.
 */
export type RequestScope =
  | { kind: "public" }
  | { kind: "authenticated"; userId?: string; userRoles?: string[] }
  | {
      kind: "member";
      userId?: string;
      userRoles: string[];
      organizationId: string;
      orgRoles: string[];
      teamId?: string;
      /**
       * App-defined scope dimensions beyond org and team. Use this to carry
       * branch / project / department / region / workspace identifiers that
       * arc itself shouldn't take a position on.
       *
       * Read with `getScopeContext(scope, key)`. Filtered by
       * `multiTenantPreset({ tenantFields: [...] })` and gated by
       * `requireScopeContext(...)`. Populated by your auth function or
       * adapter (e.g. from JWT claims, BA session fields, or request headers).
       *
       * Treat as immutable — `Readonly` enforces that at the type level.
       */
      context?: Readonly<Record<string, string>>;
      /**
       * Parent organizations the caller has access to, ordered closest-first
       * (immediate parent → … → root). Used for explicit hierarchy checks
       * via `isOrgInScope` and `requireOrgInScope` — there's no automatic
       * inheritance, every check is opt-in.
       *
       * Arc takes no position on the source — your auth function loads the
       * chain from your own org table during sign-in or middleware. Empty
       * or absent = caller has no parent orgs (the common case).
       */
      ancestorOrgIds?: readonly string[];
    }
  | {
      kind: "service";
      clientId: string;
      organizationId: string;
      scopes?: readonly string[];
      /** App-defined scope dimensions — see `member.context` for details. */
      context?: Readonly<Record<string, string>>;
      /** Parent organizations — see `member.ancestorOrgIds` for details. */
      ancestorOrgIds?: readonly string[];
    }
  | {
      kind: "elevated";
      userId?: string;
      organizationId?: string;
      elevatedBy: string;
      /** App-defined scope dimensions — see `member.context` for details. */
      context?: Readonly<Record<string, string>>;
      /** Parent organizations — see `member.ancestorOrgIds` for details. */
      ancestorOrgIds?: readonly string[];
    };

// ============================================================================
// Type Guards
// ============================================================================

/** Check if scope is `member` kind */
export function isMember(scope: RequestScope): scope is Extract<RequestScope, { kind: "member" }> {
  return scope.kind === "member";
}

/** Check if scope is `elevated` kind */
export function isElevated(
  scope: RequestScope,
): scope is Extract<RequestScope, { kind: "elevated" }> {
  return scope.kind === "elevated";
}

/** Check if scope is `service` kind (machine-to-machine auth) */
export function isService(
  scope: RequestScope,
): scope is Extract<RequestScope, { kind: "service" }> {
  return scope.kind === "service";
}

/** Check if scope has org access (member, service, or elevated) */
export function hasOrgAccess(scope: RequestScope): boolean {
  return scope.kind === "member" || scope.kind === "service" || scope.kind === "elevated";
}

/** Check if request is authenticated (any kind except public) */
export function isAuthenticated(scope: RequestScope): boolean {
  return scope.kind !== "public";
}

// ============================================================================
// Accessors
// ============================================================================

/** Get organizationId from scope (member, service, or elevated — undefined otherwise) */
export function getOrgId(scope: RequestScope): string | undefined {
  if (scope.kind === "member") return scope.organizationId;
  if (scope.kind === "service") return scope.organizationId;
  if (scope.kind === "elevated") return scope.organizationId;
  return undefined;
}

/**
 * Get stable client identity from a service scope.
 *
 * Returns the `clientId` for machine-to-machine auth (API keys, service accounts),
 * or `undefined` for any other scope kind. Use this for audit logging, rate limiting,
 * and anywhere you need to distinguish "this specific API client" from "this user".
 *
 * @example
 * ```typescript
 * const clientId = getClientId(request.scope);
 * if (clientId) {
 *   auditLog.record({ actor: clientId, action: 'create' });
 * }
 * ```
 */
export function getClientId(scope: RequestScope): string | undefined {
  if (scope.kind === "service") return scope.clientId;
  return undefined;
}

/**
 * Get OAuth-style scope strings from a service scope (e.g. `['jobs:write']`).
 * Returns an empty array for any non-service kind.
 */
export function getServiceScopes(scope: RequestScope): readonly string[] {
  if (scope.kind === "service") return scope.scopes ?? [];
  return [];
}

/** Get org roles from scope (empty array if not a member) */
export function getOrgRoles(scope: RequestScope): string[] {
  if (scope.kind === "member") return scope.orgRoles;
  return [];
}

/** Get team ID from scope (only available on member kind) */
export function getTeamId(scope: RequestScope): string | undefined {
  if (scope.kind === "member") return scope.teamId;
  return undefined;
}

/**
 * Get an app-defined scope dimension by key (e.g. `branchId`, `projectId`).
 *
 * Returns the value when the scope is `member`/`service`/`elevated` AND has
 * `context` set AND the key exists; `undefined` otherwise. Designed to be
 * the single read path for any custom tenancy dimension your app cares about
 * — branch, project, department, region, workspace, etc.
 *
 * Arc itself takes no position on what keys you use — that's your domain.
 *
 * @example
 * ```typescript
 * import { getScopeContext } from '@classytic/arc/scope';
 *
 * const branchId = getScopeContext(request.scope, 'branchId');
 * if (!branchId) return reply.code(403).send({ error: 'Branch context required' });
 * ```
 */
export function getScopeContext(scope: RequestScope, key: string): string | undefined {
  if (scope.kind === "member" || scope.kind === "service" || scope.kind === "elevated") {
    return scope.context?.[key];
  }
  return undefined;
}

/**
 * Get the full scope context map (read-only). Returns `undefined` for scope
 * kinds that don't carry context (`public`, `authenticated`).
 */
export function getScopeContextMap(
  scope: RequestScope,
): Readonly<Record<string, string>> | undefined {
  if (scope.kind === "member" || scope.kind === "service" || scope.kind === "elevated") {
    return scope.context;
  }
  return undefined;
}

/**
 * Get the parent-organization chain for a scope (closest-first, root-last).
 *
 * Returns the `ancestorOrgIds` array when the scope is `member`/`service`/
 * `elevated` and has it set; an empty array otherwise (including for kinds
 * that can't carry org context).
 *
 * Arc takes no position on what the chain represents — your auth function
 * loads it from your own data model. Common use cases: holding company →
 * subsidiaries, MSP → managed tenants, white-label parent → child accounts.
 *
 * @example
 * ```typescript
 * import { getAncestorOrgIds } from '@classytic/arc/scope';
 *
 * const ancestors = getAncestorOrgIds(request.scope);
 * if (ancestors.includes('acme-holding')) {
 *   // caller has access to a path that includes Acme Holding
 * }
 * ```
 */
export function getAncestorOrgIds(scope: RequestScope): readonly string[] {
  if (scope.kind === "member" || scope.kind === "service" || scope.kind === "elevated") {
    return scope.ancestorOrgIds ?? [];
  }
  return [];
}

/**
 * Pure predicate: does this scope grant access to `targetOrgId`?
 *
 * Returns `true` if `targetOrgId` equals the scope's `organizationId` OR
 * appears in `ancestorOrgIds`. Returns `false` otherwise — including for
 * elevated scopes (this is a pure data query, not a permission check; the
 * elevated bypass lives in `requireOrgInScope`, not here).
 *
 * Designed to be the building block for any custom hierarchy logic in your
 * own permission checks. Use `requireOrgInScope` for the route-gating
 * version that includes the elevated bypass.
 *
 * @example
 * ```typescript
 * import { isOrgInScope } from '@classytic/arc/scope';
 *
 * // Inside a custom permission check
 * if (!isOrgInScope(request.scope, request.params.orgId)) {
 *   return { granted: false, reason: 'Not in your org hierarchy' };
 * }
 * ```
 */
export function isOrgInScope(scope: RequestScope, targetOrgId: string): boolean {
  if (targetOrgId === undefined || targetOrgId === null) return false;
  if (scope.kind !== "member" && scope.kind !== "service" && scope.kind !== "elevated") {
    return false;
  }
  if (scope.organizationId === targetOrgId) return true;
  return (scope.ancestorOrgIds ?? []).includes(targetOrgId);
}

/**
 * Get userId from scope (available on authenticated, member, elevated).
 *
 * @example
 * ```typescript
 * import { getUserId } from '@classytic/arc/scope';
 * const userId = getUserId(request.scope);
 * ```
 */
export function getUserId(scope: RequestScope): string | undefined {
  if (scope.kind === "public") return undefined;
  return (scope as { userId?: string }).userId;
}

/**
 * Get global user roles from scope (available on authenticated and member).
 * These are user-level roles (e.g. superadmin, finance-admin) distinct from
 * org-level roles (scope.orgRoles).
 *
 * @example
 * ```typescript
 * import { getUserRoles } from '@classytic/arc/scope';
 * const globalRoles = getUserRoles(request.scope);
 * ```
 */
export function getUserRoles(scope: RequestScope): string[] {
  if (scope.kind === "authenticated") return scope.userRoles ?? [];
  if (scope.kind === "member") return scope.userRoles;
  return [];
}

// ============================================================================
// Context Extractors
// ============================================================================

/**
 * Org context — canonical extraction from a Fastify request.
 *
 * Works regardless of auth type (JWT, Better Auth, custom) by reading
 * `request.scope` and `request.user`. Eliminates the need for each resource
 * to re-invent org extraction from headers/user/scope.
 *
 * @example
 * ```typescript
 * import { getOrgContext } from '@classytic/arc/scope';
 *
 * handler: async (request, reply) => {
 *   const { userId, organizationId, roles, orgRoles } = getOrgContext(request);
 * }
 * ```
 */
export function getOrgContext(request: {
  scope?: RequestScope;
  user?: Record<string, unknown> | null;
  headers?: Record<string, string | string[] | undefined>;
}): {
  userId: string | undefined;
  organizationId: string | undefined;
  roles: string[];
  orgRoles: string[];
} {
  const scope = request.scope ?? { kind: "public" as const };

  // Primary: derive from scope (set by auth adapters)
  const userId =
    getUserId(scope) ??
    (request.user?.id as string | undefined) ??
    (request.user?._id as string | undefined);
  const organizationId =
    getOrgId(scope) ??
    (request.user?.organizationId as string | undefined) ??
    (request.headers?.["x-organization-id"] as string | undefined);
  const roles = getUserRoles(scope);
  const orgRoles = getOrgRoles(scope);

  return { userId, organizationId, roles, orgRoles };
}

/**
 * Read `request.scope` safely from any object that *might* have one.
 * Falls back to `PUBLIC_SCOPE` when the field is absent or undefined.
 *
 * This is the canonical way for permission checks, presets, and middleware
 * to read scope — never access `request.scope` directly because it can be
 * `undefined` on requests that haven't been touched by an auth adapter yet.
 *
 * Accepts a structural shape (`{ scope?: RequestScope }`) instead of the
 * full Fastify request type so it can be called from any layer without
 * dragging in the Fastify type. The actual runtime is identical.
 *
 * @example
 * ```typescript
 * import { getRequestScope } from '@classytic/arc/scope';
 *
 * function myCheck(ctx: PermissionContext) {
 *   const scope = getRequestScope(ctx.request);
 *   if (isElevated(scope)) return true;
 *   // ...
 * }
 * ```
 */
export function getRequestScope(request: { scope?: RequestScope }): RequestScope {
  return request.scope ?? PUBLIC_SCOPE;
}

// ============================================================================
// Constants
// ============================================================================

/** Default public scope — used as initial decoration value */
export const PUBLIC_SCOPE: Readonly<RequestScope> = Object.freeze({ kind: "public" as const });

/** Default authenticated scope — used when user is logged in but no org */
export const AUTHENTICATED_SCOPE: Readonly<RequestScope> = Object.freeze({
  kind: "authenticated" as const,
});
