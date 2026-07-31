/**
 * Permission Types - Core Type Definitions
 *
 * PermissionCheck is THE ONLY way to define permissions in Arc.
 * No string arrays, no alternative patterns.
 */

import type { FastifyRequest } from "fastify";
import type { RequestScope } from "../scope/types.js";

export { getUserRoles, normalizeRoles } from "../utils/userHelpers.js";

/**
 * Row-level data policy — the constraint every returned/queried row must
 * satisfy. This is arc's **Mongo-style record dialect** (`{ ownerId }`,
 * `{ $or: [...] }`, `{ status: { $ne: "archived" } }`), the ONE canonical
 * internal representation every permission helper emits and every enforcement
 * seam composes (`conjoinPolicyFilters`).
 *
 * It is compiled to the portable repo-core `Filter` IR at the repository
 * boundary (`core/repositoryFilter.ts` → `policyRecordToFilter`) so it runs
 * identically on Mongo / SQL / any kit — arc's answer to oso-style "data
 * filtering" + Postgres RLS, but datastore-portable and in-process. The IR is a
 * boundary/compile concern, NOT the decision surface: keeping the decision in
 * one record dialect means composition (`allOf`/`anyOf`/`conjoin`) has a single
 * well-defined shape instead of a `Filter | Record` union the composer can't
 * honor.
 */
export type DataPolicy = Record<string, unknown>;

/**
 * The canonical authorization decision (arc 2.30). A single typed value that
 * cleanly separates the concerns a permission check expresses:
 *
 *  - `effect` — allow / deny (Cedar / XACML decision)
 *  - `reason` — human-readable diagnostic for the denial (explainability)
 *  - `policy` — row-level {@link DataPolicy} to enforce at the repository
 *  - `scope`  — identity/context to install on the request (PIP)
 *
 * Build one with the `allow()` / `deny()` constructors. A check may also return
 * a bare `boolean` (terse allow/deny), normalized via `normalizeToDecision`.
 *
 * NOTE: arc deliberately does NOT model XACML-style "obligations" on the
 * decision. Audit and field redaction are first-class arc subsystems already
 * (`audit: true` on a resource; field-level read/write permissions), so an
 * obligations channel would be a second, unenforced way to ask for the same
 * effects. If a future need arises it will ship WITH a dispatcher that every
 * enforcement surface runs — never as a declared-but-ignored contract.
 */
export interface AuthorizationDecision {
  /** Allow or deny. */
  effect: "allow" | "deny";
  /** Human-readable denial reason (surfaced in error messages / explain). */
  reason?: string;
  /** Row-level data policy to enforce at the repository layer. */
  policy?: DataPolicy;
  /**
   * Scope to install on `request.scope` when allowed — flows to
   * `metadata._scope` for tenant-field filtering. The clean integration point
   * for custom auth (API keys, service accounts, gateway headers).
   */
  scope?: RequestScope;
}

/**
 * User base interface - minimal shape Arc expects
 * Your actual User can have any additional fields
 */
export interface UserBase {
  id?: string;
  _id?: string;
  /** User roles — string (comma-separated), string[], or undefined. Matches Better Auth's admin plugin pattern. */
  role?: string | string[];
  [key: string]: unknown;
}

/**
 * Context passed to permission check functions.
 *
 * arc 2.30: checks read FACTS off this context — never off a raw request. Use
 * `scopeOf(ctx)` (from `./context.js`) to read the scope; it prefers the
 * first-class {@link PermissionContext.scope} and lets combinators thread an
 * updated scope to child checks WITHOUT mutating the request. `request` is a
 * transport escape hatch (present for HTTP; absent for MCP/jobs/ws) and is being
 * retired as the primary channel.
 */
export interface PermissionContext<TDoc = Record<string, unknown>> {
  /** Authenticated user or null if unauthenticated */
  user: UserBase | null;
  /**
   * Resolved request scope (identity + tenant/org context). First-class so
   * combinators can thread an accumulated scope purely and non-HTTP transports
   * need no request. Read via `scopeOf(ctx)`.
   */
  scope?: RequestScope;
  /**
   * Raw Fastify request — transport escape hatch, present ONLY on the HTTP
   * surface. It is `undefined` for MCP, jobs, and any non-Fastify transport, so
   * a permission check must NOT depend on it: read identity via `scopeOf(ctx)`,
   * inputs via `ctx.data` / `ctx.params`, and host facts via `ctx.attributes`.
   * Kept solely for genuinely HTTP-coupled checks (e.g. a usage meter on
   * `request.server`) which are inherently transport-specific.
   */
  request?: FastifyRequest;
  /** Resource name being accessed */
  resource: string;
  /** Action being performed (list, get, create, update, delete, or custom operation name) */
  action: string;
  /** Resource ID for single-resource operations (shortcut for params.id) */
  resourceId?: string;
  /** All route parameters (slug, parentId, custom params, etc.) */
  params?: Record<string, string>;
  /** Request body data */
  data?: Partial<TDoc> | Record<string, unknown>;
  /**
   * Transport/host-supplied attributes a check may need for ABAC decisions
   * (headers, claims, feature flags) without reaching into the raw request.
   */
  attributes?: Readonly<Record<string, unknown>>;
}

/**
 * Permission Check Function — THE way to define permissions in Arc.
 *
 * Returns a `boolean` (terse allow/deny) or an {@link AuthorizationDecision}
 * (effect + optional data `policy` and `scope`). Build decisions with the
 * `allow()` / `deny()` constructors from `@classytic/arc/permissions`.
 *
 * @example
 * ```typescript
 * // Simple boolean
 * const isAdmin: PermissionCheck = (ctx) => getUserRoles(ctx.user).includes('admin');
 *
 * // Grant + row-level data policy (ownership)
 * const ownedByUser: PermissionCheck = (ctx) =>
 *   allow({ policy: { userId: ctx.user?.id } });
 *
 * // Custom API-key auth — grant AND install a service scope
 * const requireApiKey: PermissionCheck = async ({ request }) => {
 *   const client = await lookup(request.headers['x-api-key']);
 *   if (!client) return deny('Invalid API key');
 *   return allow({
 *     scope: { kind: 'service', clientId: String(client._id), organizationId: String(client.companyId) },
 *     ...(client.projectId ? { policy: { projectId: client.projectId } } : {}),
 *   });
 * };
 * ```
 */
export type PermissionCheck<TDoc = Record<string, unknown>> = ((
  context: PermissionContext<TDoc>,
) => boolean | AuthorizationDecision | Promise<boolean | AuthorizationDecision>) &
  PermissionCheckMeta;

/**
 * Optional metadata attached to permission check functions.
 * Used for OpenAPI data, introspection, and route-level auth decisions.
 *
 * Each helper from `permissions/index.ts` writes its own discriminating tag
 * so downstream tooling (OpenAPI generator, MCP resource builder, route
 * audit utilities) can read off the requirement without re-parsing the
 * function body. All fields are optional — only the helpers that emit them
 * set them.
 */
export interface PermissionCheckMeta {
  /** Set by allowPublic() — marks the endpoint as publicly accessible */
  _isPublic?: boolean;
  /**
   * Set by requireAuth() — a pure identity gate (must be signed in) that adds NO
   * row-level or environmental condition. Marked so `allOf` does not mistake it
   * for an opaque runtime branch and needlessly taint the composite `conditional`.
   */
  _requiresAuth?: boolean;
  /** Set by requireRoles() — the roles required for access */
  _roles?: readonly string[];
  /**
   * Set by `requirePlatformRole()` — this gate consults PLATFORM roles only and
   * can never be satisfied by an organization role.
   *
   * It exists because that property is otherwise unprovable from outside a
   * check. `requireRoles(["ops"])` accepts an ORG role named `ops` by default,
   * and `requireOrgRole("manager")` grants any org's manager — both return a
   * bare allow with no policy, so a surface that must be platform-wide cannot
   * tell them apart from a genuine operator gate by inspecting the decision.
   * A global surface (see `jobsPlugin`'s `managementRoutes`) requires this
   * marker at boot rather than trusting the caller's intent.
   */
  _platformOnly?: boolean;
  /** Set by requireOrgMembership() — org-level permission type */
  _orgPermission?: string;
  /** Set by requireOrgRole() — the org roles required for access */
  _orgRoles?: readonly string[];
  /** Set by requireTeamMembership() — team-level permission type */
  _teamPermission?: string;
  /**
   * Set by requireServiceScope() — the OAuth-style scope strings the
   * caller's `service` identity must hold (any-match logic, parallels
   * `_orgRoles`).
   */
  _serviceScopes?: readonly string[];
  /**
   * Set by requireScopeContext() — the app-defined scope dimensions the
   * caller must satisfy. Map keys are dimension names (`branchId`,
   * `projectId`, etc.); values are the required string OR `undefined`
   * for "must be present, any value".
   */
  _scopeContext?: Record<string, string | undefined>;
  /**
   * Set by requireOrgInScope() — the target organization that must appear
   * in the caller's org chain (current org or `ancestorOrgIds`). Either
   * a static org id or a function extracting it from the request context
   * (e.g. from route params).
   */
  _orgInScopeTarget?: string | ((ctx: PermissionContext) => string | undefined);
  /**
   * Set by requireDPoP() — the inbound credential must be sender-constrained
   * via DPoP (RFC 9449), with `scope.dpopJkt` set by the authenticate
   * function after a successful proof verification.
   */
  _dpopRequired?: boolean;
  /**
   * Set by requireMandate() — the capability string the mandate on
   * `scope.mandate` must authorize (e.g. `payment.charge`, `data.export`).
   */
  _mandateCapability?: string;
  /**
   * Set by requireAgentScope() — composite descriptor for AI-agent flows.
   * Tools (audit, OpenAPI, MCP) can render the full agent-auth requirement
   * in one read instead of unpacking three separate metadata fields.
   */
  _agentScope?: {
    capability: string;
    scopes?: readonly string[];
    dpop: boolean;
  };
  /**
   * Set by `allOf(...)` when its surfaced role/scope meta is NECESSARY but NOT
   * SUFFICIENT — the conjunction also contains an opaque runtime branch
   * (ownership / custom / dynamic / flow-mode / quota …) or a contradictory
   * constraint that flat metadata can't capture. `describePermission` propagates
   * it as `conditional: true`, so `explainAccess` reports a role/scope MATCH as
   * `conditional` (server decides) instead of a definitive — and unsound —
   * `allow`. A role/scope MISMATCH is still a definitive `deny` (a necessary
   * condition failed). Without this flag a composed gate could tell a UI "you can"
   * when the runtime check will refuse.
   */
  _conditional?: boolean;
}
