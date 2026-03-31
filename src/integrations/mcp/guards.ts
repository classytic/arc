/**
 * @classytic/arc — MCP Tool Guards
 *
 * Reusable permission helpers for custom MCP tools.
 * Same patterns as Arc's REST permission helpers, adapted for ToolContext.
 *
 * Two ways to use:
 *
 * 1. **Guard wrapper** — wraps a tool handler, rejects before execution:
 *    ```ts
 *    defineTool('admin_action', {
 *      description: 'Admin only',
 *      handler: guard(requireRole('admin'), async (input, ctx) => { ... }),
 *    });
 *    ```
 *
 * 2. **Inline check** — call inside handler for conditional logic:
 *    ```ts
 *    handler: async (input, ctx) => {
 *      if (!isAuthenticated(ctx)) return denied('Login required');
 *      if (!hasOrg(ctx)) return denied('Org context required');
 *      // ...
 *    },
 *    ```
 */

import type { CallToolResult, McpAuthResult, ToolContext } from "./types.js";

// ============================================================================
// Check Functions — use inline in handlers
// ============================================================================

/** Check if the tool context has an authenticated user (not anonymous/null) */
export function isAuthenticated(ctx: ToolContext): boolean {
  return !!ctx.session && ctx.session.userId !== "anonymous";
}

/** Check if the tool context has an organization scope */
export function hasOrg(ctx: ToolContext): boolean {
  return !!ctx.session?.organizationId;
}

/** Check if the tool context matches a specific org */
export function isOrg(ctx: ToolContext, orgId: string): boolean {
  return ctx.session?.organizationId === orgId;
}

/** Get the current user ID from context (undefined if anonymous/null) */
export function getUserId(ctx: ToolContext): string | undefined {
  const id = ctx.session?.userId;
  return id && id !== "anonymous" ? id : undefined;
}

/** Get the current org ID from context */
export function getOrgId(ctx: ToolContext): string | undefined {
  return ctx.session?.organizationId;
}

// ============================================================================
// Denied Response Helper
// ============================================================================

/** Create a denied (isError) CallToolResult */
export function denied(reason: string): CallToolResult {
  return { content: [{ type: "text", text: reason }], isError: true };
}

// ============================================================================
// Guard Factories — wrap handlers with pre-checks
// ============================================================================

/** Guard type — checks ToolContext, returns error message or null (pass) */
export type McpGuard = (ctx: ToolContext) => string | null | Promise<string | null>;

/**
 * Wrap a tool handler with one or more guards.
 * If any guard returns a string, the tool returns an error with that message.
 *
 * @example
 * ```ts
 * defineTool('delete_all', {
 *   description: 'Delete everything',
 *   handler: guard(requireAuth, requireOrg, async (input, ctx) => {
 *     // only runs if authenticated + has org
 *   }),
 * });
 * ```
 */
export function guard(
  ...args: [
    ...McpGuard[],
    (input: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>,
  ]
): (input: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult> {
  const handler = args.pop() as (
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<CallToolResult>;
  const guards = args as McpGuard[];

  return async (input, ctx) => {
    for (const g of guards) {
      const err = await g(ctx);
      if (err) return denied(err);
    }
    return handler(input, ctx);
  };
}

// ============================================================================
// Built-in Guards
// ============================================================================

/** Require authenticated user (not anonymous) */
export const requireAuth: McpGuard = (ctx) =>
  isAuthenticated(ctx) ? null : "Authentication required";

/** Require organization context */
export const requireOrg: McpGuard = (ctx) => (hasOrg(ctx) ? null : "Organization context required");

/** Require specific user role (checks session metadata if available) */
export function requireRole(...roles: string[]): McpGuard {
  return (ctx) => {
    if (!isAuthenticated(ctx)) return "Authentication required";
    // Role info comes from the auth resolver — check session for role data
    const session = ctx.session as McpAuthResult & { roles?: string[] };
    const userRoles = session?.roles ?? [];
    const hasRole = roles.some((r) => userRoles.includes(r));
    return hasRole ? null : `Required role: ${roles.join(" or ")}`;
  };
}

/** Require specific organization */
export function requireOrgId(orgId: string): McpGuard {
  return (ctx) => (isOrg(ctx, orgId) ? null : `Access restricted to organization ${orgId}`);
}

/**
 * Custom guard from a predicate function.
 *
 * @example
 * ```ts
 * const businessHoursOnly = customGuard(
 *   (ctx) => new Date().getHours() >= 9 && new Date().getHours() < 17,
 *   'This tool is only available during business hours (9-5)',
 * );
 * ```
 */
export function customGuard(
  check: (ctx: ToolContext) => boolean | Promise<boolean>,
  errorMessage: string,
): McpGuard {
  return async (ctx) => {
    const allowed = await check(ctx);
    return allowed ? null : errorMessage;
  };
}
