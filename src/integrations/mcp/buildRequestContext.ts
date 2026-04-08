/**
 * @classytic/arc — MCP → IRequestContext Bridge
 *
 * Builds an IRequestContext from MCP tool input + session identity.
 * Ensures MCP tool handlers go through the same BaseController pipeline
 * as REST requests (AccessControl, BodySanitizer, QueryResolver, HookSystem).
 */

import type { RequestScope } from "../../scope/types.js";
import type { IRequestContext } from "../../types/index.js";
import type { McpAuthResult } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type McpOperation = "list" | "get" | "create" | "update" | "delete";

// ============================================================================
// Main
// ============================================================================

/**
 * Build an IRequestContext from MCP tool input and session auth.
 *
 * | Operation | params     | query                | body                |
 * |-----------|------------|----------------------|---------------------|
 * | list      | {}         | all input fields     | undefined           |
 * | get       | { id }     | {}                   | undefined           |
 * | create    | {}         | {}                   | all input fields    |
 * | update    | { id }     | {}                   | input minus id      |
 * | delete    | { id }     | {}                   | undefined           |
 *
 * **scopeOverride** — when a permission check (e.g. `requireApiKey()`) returns
 * `PermissionResult.scope`, the MCP tool handler must install it on the request
 * context the same way CRUD/action routes do. This parameter follows the exact
 * same non-downgrade rule as `applyPermissionResult`: it overrides only when
 * the session-derived scope is `public` (i.e. MCP called with `auth: false`).
 * An authenticated session scope is never overwritten.
 */
export function buildRequestContext(
  input: Record<string, unknown>,
  auth: McpAuthResult | null,
  operation: McpOperation,
  policyFilters?: Record<string, unknown>,
  scopeOverride?: RequestScope,
): IRequestContext {
  const sessionScope = buildScope(auth);
  // Honor scopeOverride only when session is still public (same rule as
  // applyPermissionResult). This prevents a permission check from downgrading
  // an authenticated Better-Auth session to a narrower service scope.
  const scope: RequestScope =
    scopeOverride && sessionScope.kind === "public" ? scopeOverride : sessionScope;
  // Machine principals (clientId without userId) → null user.
  // This keeps audit trails clean: ctx.user is only set for human principals.
  const user = auth?.userId ? { id: auth.userId, _id: auth.userId, ...auth } : null;

  const base = {
    user: user as IRequestContext["user"],
    headers: {} as Record<string, string | undefined>,
    context: {},
    metadata: { _scope: scope, _policyFilters: policyFilters ?? {} },
  };

  switch (operation) {
    case "list":
      return { ...base, params: {}, query: expandOperatorKeys(input), body: undefined };

    case "get":
      return { ...base, params: { id: String(input.id ?? "") }, query: {}, body: undefined };

    case "create": {
      return { ...base, params: {}, query: {}, body: { ...input } };
    }

    case "update": {
      const { id: _id, ...body } = input;
      return { ...base, params: { id: String(_id ?? "") }, query: {}, body };
    }

    case "delete":
      return { ...base, params: { id: String(input.id ?? "") }, query: {}, body: undefined };
  }
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Convert MCP operator keys (`price_gt`, `location_withinRadius`) to the
 * nested object shape MongoKit's QueryParser expects (`{ price: { gt: ... } }`,
 * `{ location: { withinRadius: ... } }`).
 *
 * **Comparison operators** (price_gt, age_lte, …): coerce filter values via
 * the parser's coercion path.
 *
 * **Set operators** (status_in, role_nin, …): MongoKit accepts both
 * comma-separated strings and arrays.
 *
 * **Existence** (deletedAt_exists): coerced to boolean by the parser.
 *
 * **Geo operators** (location_near, location_withinRadius, location_geoWithin,
 * location_nearSphere): MongoKit 3.5.5+ — values are coordinate strings the
 * parser's geo primitive handles. Without these in the allowlist, MCP agents
 * couldn't pass geo filters at all and Arc would silently leak unfiltered docs.
 *
 * Keep this set in sync with MongoKit's QueryParser operators map (search for
 * `private readonly operators` in QueryParser.ts) plus the geo operators
 * recognized by `isGeoOperator` in primitives/geo.ts. We deliberately list
 * them explicitly here rather than asking the parser at runtime — Arc must
 * not import MongoKit internals just to know what an operator looks like.
 */
const OPERATOR_SUFFIXES = new Set([
  // Equality + comparison
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  // Set
  "in",
  "nin",
  // Misc
  "exists",
  "size",
  "type",
  // String
  "like",
  "contains",
  "regex",
  // Geo (MongoKit 3.5.5+)
  "near",
  "nearSphere",
  "withinRadius",
  "geoWithin",
]);

function expandOperatorKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lastUnderscore = key.lastIndexOf("_");
    if (lastUnderscore > 0) {
      const op = key.slice(lastUnderscore + 1);
      if (OPERATOR_SUFFIXES.has(op)) {
        const field = key.slice(0, lastUnderscore);
        // Nest into bracket notation: { price: { gt: value } }
        const existing = out[field];
        if (existing && typeof existing === "object" && existing !== null) {
          (existing as Record<string, unknown>)[op] = value;
        } else if (existing === undefined) {
          out[field] = { [op]: value };
        } else {
          // Exact match already set — keep it, add operator alongside
          out[field] = { eq: existing, [op]: value };
        }
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function buildScope(auth: McpAuthResult | null): RequestScope {
  if (!auth) return { kind: "public" };

  // Service scope — machine-to-machine auth (clientId present, no human userId or userId is the client itself)
  if (auth.clientId && auth.organizationId) {
    return {
      kind: "service",
      clientId: auth.clientId,
      organizationId: auth.organizationId,
      scopes: auth.scopes,
    };
  }

  // Member scope — human user with org context
  if (auth.organizationId) {
    return {
      kind: "member",
      userId: auth.userId,
      userRoles: auth.roles ?? [],
      organizationId: auth.organizationId,
      orgRoles: auth.orgRoles ?? [],
    };
  }

  // Authenticated scope — human user without org context
  return { kind: "authenticated", userId: auth.userId, userRoles: auth.roles ?? [] };
}
