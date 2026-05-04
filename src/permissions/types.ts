/**
 * Permission Types - Core Type Definitions
 *
 * PermissionCheck is THE ONLY way to define permissions in Arc.
 * No string arrays, no alternative patterns.
 */

import type { FastifyRequest } from "fastify";
import type { RequestScope } from "../scope/types.js";

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
 * Extract normalized roles from a user object.
 *
 * Reads `user.role` which can be:
 * - A comma-separated string: `"superadmin,user"` (Better Auth admin plugin)
 * - A string array: `["admin", "user"]` (JWT / custom auth)
 * - A single string: `"admin"`
 */
/**
 * Normalize a raw role value (string, comma-separated string, or array) into a string[].
 * Shared low-level helper used by both getUserRoles() and the Better Auth adapter.
 */
export function normalizeRoles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((r) => String(r).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.length > 0) {
    return value
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return [];
}

export function getUserRoles(user: UserBase | null | undefined): string[] {
  if (!user) return [];
  return normalizeRoles(user.role);
}

/**
 * Context passed to permission check functions
 */
export interface PermissionContext<TDoc = Record<string, unknown>> {
  /** Authenticated user or null if unauthenticated */
  user: UserBase | null;
  /** Fastify request object */
  request: FastifyRequest;
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
}

/**
 * Result from a permission check.
 *
 * Permission checks can do three things:
 * 1. **Grant or deny** access (`granted`, `reason`)
 * 2. **Attach row-level filters** (`filters`) — these merge into `_policyFilters`
 *    and narrow subsequent queries (e.g. `{ userId: ctx.user.id }` for ownership)
 * 3. **Install the request scope** (`scope`) — when a custom authenticator wants
 *    to set tenant/identity context directly from the permission layer, without
 *    relying on a separate auth plugin
 *
 * The `scope` field is the clean integration point for custom auth strategies
 * (API keys, service accounts, gateway headers). When present, Arc writes it to
 * `request.scope` which then flows through the normal tenant-filtering pipeline
 * (QueryResolver + AccessControl). This is the idiomatic way to wire non-Better-Auth
 * identity providers into Arc's multi-tenancy without touching the auth plugin layer.
 *
 * @example
 * ```typescript
 * // Custom API-key auth — grant access AND install a service scope in one step
 * export function requireApiKey(): PermissionCheck {
 *   return async ({ request }) => {
 *     const apiKey = request.headers['x-api-key'] as string | undefined;
 *     if (!apiKey) return { granted: false, reason: 'Missing API key' };
 *
 *     const client = await ClientModel.findOne({ apiKey });
 *     if (!client) return { granted: false, reason: 'Invalid API key' };
 *
 *     return {
 *       granted: true,
 *       // Install service scope — Arc writes this to request.scope automatically,
 *       // and tenantField filtering picks it up via metadata._scope
 *       scope: {
 *         kind: 'service',
 *         clientId: String(client._id),
 *         organizationId: String(client.companyId),
 *         scopes: client.allowedScopes,
 *       },
 *       // Optional row-level narrowing (e.g. per-project API keys)
 *       filters: client.projectId ? { projectId: client.projectId } : undefined,
 *     };
 *   };
 * }
 * ```
 */
export interface PermissionResult {
  /** Whether access is granted */
  granted: boolean;
  /** Reason for denial (for error messages) */
  reason?: string;
  /** Query filters to apply (for ownership / row-level security patterns) */
  filters?: Record<string, unknown>;
  /**
   * Install this scope on `request.scope` when granted. Flows through to
   * `metadata._scope` and is read by QueryResolver / AccessControl for
   * tenant-field filtering. Use this to wire custom auth (API keys, service
   * accounts, gateway headers) into Arc's multi-tenancy without a separate
   * auth plugin.
   */
  scope?: RequestScope;
}

/**
 * Permission Check Function
 *
 * THE ONLY way to define permissions in Arc.
 * Returns boolean, PermissionResult, or Promise of either.
 *
 * @example
 * ```typescript
 * // Simple boolean return
 * const isAdmin: PermissionCheck = (ctx) => getUserRoles(ctx.user).includes('admin');
 *
 * // With filters for ownership
 * const ownedByUser: PermissionCheck = (ctx) => ({
 *   granted: true,
 *   filters: { userId: ctx.user?.id }
 * });
 *
 * // Async check
 * const canAccessOrg: PermissionCheck = async (ctx) => {
 *   const isMember = await checkMembership(ctx.user?.id, ctx.organizationId);
 *   return { granted: isMember, reason: isMember ? undefined : 'Not a member' };
 * };
 * ```
 */
export type PermissionCheck<TDoc = Record<string, unknown>> = ((
  context: PermissionContext<TDoc>,
) => boolean | PermissionResult | Promise<boolean | PermissionResult>) &
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
  /** Set by requireRoles() — the roles required for access */
  _roles?: readonly string[];
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
}
