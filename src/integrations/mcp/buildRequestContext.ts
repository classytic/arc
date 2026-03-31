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
 */
export function buildRequestContext(
  input: Record<string, unknown>,
  auth: McpAuthResult | null,
  operation: McpOperation,
): IRequestContext {
  const scope = buildScope(auth);
  const user = auth ? { id: auth.userId, _id: auth.userId } : null;

  const base = {
    user: user as IRequestContext["user"],
    headers: {} as Record<string, string | undefined>,
    context: {},
    metadata: { _scope: scope, _policyFilters: {} },
  };

  switch (operation) {
    case "list":
      return { ...base, params: {}, query: { ...input }, body: undefined };

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

function buildScope(auth: McpAuthResult | null): RequestScope {
  if (!auth) return { kind: "public" };
  if (auth.organizationId) {
    return {
      kind: "member",
      userId: auth.userId,
      userRoles: [],
      organizationId: auth.organizationId,
      orgRoles: [],
    };
  }
  return { kind: "authenticated", userId: auth.userId, userRoles: [] };
}
