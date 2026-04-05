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
  policyFilters?: Record<string, unknown>,
): IRequestContext {
  const scope = buildScope(auth);
  const user = auth ? { id: auth.userId, _id: auth.userId, ...auth } : null;

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

/** Convert MCP operator keys (`price_gt`) to MongoKit bracket notation (`price[gt]`). */
const OPERATOR_SUFFIXES = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "exists"]);

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
