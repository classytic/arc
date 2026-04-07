/**
 * PermissionResult Application — Single Source of Truth
 *
 * Every path in Arc that evaluates a permission check (CRUD routes, action
 * routes, MCP tool handlers) must apply the result's side-effects identically:
 *
 *   1. `filters` → merge into `_policyFilters` (row-level security narrowing)
 *   2. `scope`   → install on `request.scope` WITHOUT downgrading existing auth
 *
 * Historically each call site re-implemented this logic inline, and they drifted:
 * - `createCrudRouter` handled filters + scope (correct)
 * - `createActionRouter` ignored both (bug — action handlers saw no scope/filters)
 * - MCP tool handlers ignored scope (bug — custom-auth scope never reached controllers)
 *
 * This module is the ONLY place that knows how to apply a PermissionResult.
 * All three call sites now funnel through here so the behavior can't drift again.
 *
 * @example
 * ```typescript
 * // In a Fastify middleware after running a permission check:
 * const result = await permissionCheck(ctx);
 * const normalized = normalizePermissionResult(result);
 * if (!normalized.granted) return reply.code(401).send(...);
 * applyPermissionResult(normalized, request);
 * // At this point: request._policyFilters and request.scope are up to date
 * ```
 */

import type { FastifyRequest } from "fastify";
import type { RequestScope } from "../scope/types.js";
import type { PermissionResult } from "./types.js";

// ============================================================================
// Normalize
// ============================================================================

/**
 * Normalize a permission check return value (`boolean | PermissionResult`)
 * into a concrete `PermissionResult`. This is the only place in Arc that
 * promotes booleans to results — keeps the type narrowing honest everywhere.
 */
export function normalizePermissionResult(result: boolean | PermissionResult): PermissionResult {
  if (typeof result === "boolean") {
    return { granted: result };
  }
  return result;
}

// ============================================================================
// Apply to Fastify request
// ============================================================================

/**
 * Minimal shape of a Fastify request that can receive permission side-effects.
 * We avoid depending on the full augmented `FastifyRequest` type here because
 * `_policyFilters` / `scope` are declared via ambient module augmentation in
 * multiple places and the unaugmented interface is what the core routers see.
 */
type RequestSink = FastifyRequest & {
  _policyFilters?: Record<string, unknown>;
  scope?: RequestScope;
};

/**
 * Apply a granted `PermissionResult` to a Fastify request — merges row-level
 * filters into `_policyFilters` and conditionally installs the scope.
 *
 * **Scope install rule:** only writes `scope` when the current request scope
 * is absent or `public`. This prevents downgrading an already-authenticated
 * request (e.g. Better Auth set `member`, then a permission check returns a
 * narrower `service` scope — the original `member` wins because it came from
 * a more authoritative source).
 *
 * Safe to call with a non-granted result — it simply no-ops. Callers should
 * still check `result.granted` and send an error response before reaching here,
 * but this function tolerates the misuse defensively.
 */
export function applyPermissionResult(result: PermissionResult, request: RequestSink): void {
  if (!result.granted) return;

  // Merge filters into _policyFilters (last-writer-wins per key, which matches
  // the historical behavior — later middlewares can refine earlier filters).
  if (result.filters) {
    request._policyFilters = {
      ...(request._policyFilters ?? {}),
      ...result.filters,
    };
  }

  // Install scope only when we haven't already been authenticated.
  // "public" counts as unauthenticated — everything else is honored as-is.
  if (result.scope) {
    const current = request.scope;
    if (!current || current.kind === "public") {
      request.scope = result.scope;
    }
  }
}
