/**
 * Shared scope/permission-context factories for tests.
 *
 * Designed to make permission-system tests trivially short and consistent
 * across files. Every new permission helper test file should import from
 * here instead of rolling its own makeMemberCtx / makeServiceCtx / etc.
 *
 * Five named factories — one per `RequestScope` kind — each accepting only
 * the fields its scope kind actually carries. All fields optional with
 * sensible defaults so a typical call like `makeMemberCtx({ orgRoles: ['admin'] })`
 * just works. For total control over the scope shape, use `makeCtx(scope)`.
 *
 * **Extending**: when a new field is added to `RequestScope` (e.g. a future
 * `regionId` slot), add it to the corresponding factory's options bag here
 * — every test file that uses the factory picks it up automatically.
 */

import type { PermissionContext, UserBase } from "../../src/permissions/types.js";
import type { Mandate, RequestScope } from "../../src/scope/types.js";

// ============================================================================
// Common request-side options (params, body, user, resource, action)
// ============================================================================

export interface PermissionCtxRequestOptions<TDoc = Record<string, unknown>> {
  /**
   * Authenticated user object. If omitted: services get `null` automatically;
   * member/elevated default to `{ id: 'user-1', role: [] }` (or the userId
   * field if you provided one); public/authenticated default to `null` /
   * `{ id: 'user-1' }` respectively.
   *
   * Pass `null` explicitly to override the default for member/elevated.
   */
  user?: UserBase | null;
  /** Resource name on the PermissionContext — defaults to `'job'`. */
  resource?: string;
  /** Action on the PermissionContext — defaults to `'create'`. */
  action?: string;
  /** request.params for extractor-style helpers (e.g. `requireOrgInScope`). */
  params?: Record<string, string>;
  /** request.body for extractor-style helpers. */
  body?: Record<string, unknown>;
  /** Phantom — keeps TDoc bound to PermissionContext for downstream type-narrowing. */
  __doc?: TDoc;
}

// ============================================================================
// Lowest-level primitive — build a PermissionContext from any RequestScope
// ============================================================================

/**
 * Build a `PermissionContext` from an arbitrary `RequestScope`. Use this
 * when none of the named factories fit (e.g. a test that constructs a
 * scope variant inline for a specific edge case).
 */
export function makeCtx<TDoc = Record<string, unknown>>(
  scope: RequestScope,
  opts: PermissionCtxRequestOptions<TDoc> = {},
): PermissionContext<TDoc> {
  // Default `user` per scope kind:
  //   - public                 → null
  //   - service                → null (machine identity, no user)
  //   - authenticated/member/  → { id, role: [] } (real human)
  //     elevated
  let defaultUser: UserBase | null;
  if (scope.kind === "public" || scope.kind === "service") {
    defaultUser = null;
  } else {
    const userIdFromScope =
      "userId" in scope && typeof scope.userId === "string" ? scope.userId : "user-1";
    defaultUser = { id: userIdFromScope, role: [] };
  }

  return {
    user: opts.user === undefined ? defaultUser : opts.user,
    request: {
      scope,
      params: opts.params ?? {},
      body: opts.body ?? {},
    } as unknown as PermissionContext<TDoc>["request"],
    resource: opts.resource ?? "job",
    action: opts.action ?? "create",
  };
}

// ============================================================================
// Named factories — one per RequestScope kind
// ============================================================================

/**
 * Build a public (unauthenticated) `PermissionContext`.
 *
 * @example
 * ```typescript
 * expect(check(makePublicCtx())).toMatchObject({ granted: false });
 * ```
 */
export function makePublicCtx<TDoc = Record<string, unknown>>(
  opts: PermissionCtxRequestOptions<TDoc> = {},
): PermissionContext<TDoc> {
  return makeCtx({ kind: "public" }, opts);
}

/**
 * Build an `authenticated` (logged-in but no org context) `PermissionContext`.
 */
export function makeAuthenticatedCtx<TDoc = Record<string, unknown>>(
  opts: PermissionCtxRequestOptions<TDoc> & {
    userId?: string;
    userRoles?: string[];
  } = {},
): PermissionContext<TDoc> {
  const { userId, userRoles, ...request } = opts;
  return makeCtx({ kind: "authenticated", userId: userId ?? "user-1", userRoles }, request);
}

/**
 * Build a `member` (org-bound human) `PermissionContext`. The most common
 * factory in permission tests.
 */
export function makeMemberCtx<TDoc = Record<string, unknown>>(
  opts: PermissionCtxRequestOptions<TDoc> & {
    userId?: string;
    userRoles?: string[];
    organizationId?: string;
    orgRoles?: string[];
    teamId?: string;
    context?: Record<string, string>;
    ancestorOrgIds?: readonly string[];
  } = {},
): PermissionContext<TDoc> {
  const {
    userId,
    userRoles,
    organizationId,
    orgRoles,
    teamId,
    context,
    ancestorOrgIds,
    ...request
  } = opts;
  return makeCtx(
    {
      kind: "member",
      userId: userId ?? "user-1",
      userRoles: userRoles ?? [],
      organizationId: organizationId ?? "org-acme",
      orgRoles: orgRoles ?? ["member"],
      teamId,
      // Freeze the context so tests can't accidentally mutate it
      context: context ? Object.freeze({ ...context }) : undefined,
      ancestorOrgIds,
    },
    request,
  );
}

/**
 * Build a `service` (API key / machine identity) `PermissionContext`.
 * `user` defaults to `null` — services have no associated human.
 */
export function makeServiceCtx<TDoc = Record<string, unknown>>(
  opts: PermissionCtxRequestOptions<TDoc> & {
    clientId?: string;
    organizationId?: string;
    scopes?: readonly string[];
    context?: Record<string, string>;
    ancestorOrgIds?: readonly string[];
    /** Capability mandate for AI-agent flows (AP2 / x402 / MCP authorization). */
    mandate?: Mandate;
    /** DPoP key thumbprint for sender-constrained credentials (RFC 9449). */
    dpopJkt?: string;
  } = {},
): PermissionContext<TDoc> {
  const {
    clientId,
    organizationId,
    scopes,
    context,
    ancestorOrgIds,
    mandate,
    dpopJkt,
    ...request
  } = opts;
  return makeCtx(
    {
      kind: "service",
      clientId: clientId ?? "client-test",
      organizationId: organizationId ?? "org-acme",
      scopes,
      context: context ? Object.freeze({ ...context }) : undefined,
      ancestorOrgIds,
      mandate: mandate ? (Object.freeze({ ...mandate }) as Mandate) : undefined,
      dpopJkt,
    },
    request,
  );
}

/**
 * Build an `elevated` (platform admin via `x-arc-scope: platform`)
 * `PermissionContext`. `organizationId` is intentionally optional —
 * elevated admins can act with no org for cross-tenant operations.
 */
export function makeElevatedCtx<TDoc = Record<string, unknown>>(
  opts: PermissionCtxRequestOptions<TDoc> & {
    userId?: string;
    organizationId?: string;
    elevatedBy?: string;
    context?: Record<string, string>;
    ancestorOrgIds?: readonly string[];
  } = {},
): PermissionContext<TDoc> {
  const { userId, organizationId, elevatedBy, context, ancestorOrgIds, ...request } = opts;
  return makeCtx(
    {
      kind: "elevated",
      userId: userId ?? "admin-1",
      elevatedBy: elevatedBy ?? "x-arc-scope",
      organizationId,
      context: context ? Object.freeze({ ...context }) : undefined,
      ancestorOrgIds,
    },
    // Elevated default user is a platform admin with the conventional role
    {
      ...request,
      user:
        request.user === undefined
          ? { id: userId ?? "admin-1", role: ["superadmin"] }
          : request.user,
    },
  );
}
