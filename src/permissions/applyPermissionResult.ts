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

import type { FastifyReply, FastifyRequest } from "fastify";
import type { RequestScope } from "../scope/types.js";
import type { PermissionCheck, PermissionContext, PermissionResult, UserBase } from "./types.js";

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

// ============================================================================
// Evaluate + apply (end-to-end permission flow)
// ============================================================================

/**
 * Max length of a `PermissionResult.reason` string before we fall back to the
 * generic default message. Upstream checks can return arbitrary strings; we
 * clamp to prevent accidental leakage of internal diagnostics or oversized
 * payloads via the 4xx response body.
 */
const MAX_DENIAL_REASON_LENGTH = 100;

/**
 * End-to-end evaluator: runs the permission check, catches throws, normalizes
 * the result, sends a 401/403 response on denial, and applies side-effects on
 * grant. Returns `true` if the caller should continue, `false` if a response
 * has been sent and the caller should return.
 *
 * This is the single source of truth for the 5-step sequence shared by the
 * CRUD router, action router, and MCP tool handlers:
 *
 *   1. `try { await check(ctx) } catch { reply 403 }`
 *   2. `normalizePermissionResult(result)`
 *   3. If denied → 401 (no user) or 403 (user) with clamped reason
 *   4. If granted → `applyPermissionResult` (filters + scope)
 *   5. Return true/false so the caller knows whether to keep going
 *
 * Context construction, pre-check auth gating, and success-path handler
 * invocation stay at the callsite — those are genuinely different per router
 * and don't belong here.
 *
 * @returns `true` if authorized (caller continues), `false` if a response was sent
 */
export async function evaluateAndApplyPermission(
  check: PermissionCheck,
  context: PermissionContext,
  request: FastifyRequest,
  reply: FastifyReply,
  opts?: {
    /**
     * Override the default denial message. Receives the user from the
     * permission context (null on unauthenticated requests). The returned
     * string is used only when `result.reason` is absent or exceeds
     * `MAX_DENIAL_REASON_LENGTH`. Defaults to `"Permission denied"` /
     * `"Authentication required"`.
     */
    defaultDenialMessage?: (user: UserBase | null) => string;
  },
): Promise<boolean> {
  // Step 1: run the check, catch throws
  let result: boolean | PermissionResult;
  try {
    result = await check(context);
  } catch (err) {
    request.log?.warn?.(
      { err, resource: context.resource, action: context.action },
      "Permission check threw",
    );
    reply.code(403).send({
      code: "arc.forbidden",
      message: "Permission denied",
      status: 403,
    });
    return false;
  }

  // Step 2: normalize
  const permResult = normalizePermissionResult(result);

  // Step 3: denial → shape response
  if (!permResult.granted) {
    const defaultMsg =
      opts?.defaultDenialMessage?.(context.user) ??
      (context.user ? "Permission denied" : "Authentication required");
    const reason =
      permResult.reason && permResult.reason.length <= MAX_DENIAL_REASON_LENGTH
        ? permResult.reason
        : defaultMsg;
    const status = context.user ? 403 : 401;
    reply.code(status).send({
      code: context.user ? "arc.forbidden" : "arc.unauthorized",
      message: reason,
      status,
    });
    return false;
  }

  // Step 4: grant → apply side-effects (filters + scope)
  applyPermissionResult(permResult, request);
  return true;
}
