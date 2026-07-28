/**
 * AuthorizationDecision Application — Single Source of Truth (arc 2.30)
 *
 * Every path in Arc that evaluates a permission check (CRUD routes, action
 * routes, aggregation routes, MCP tool handlers) applies the decision's
 * side-effects identically here:
 *
 *   1. `policy` → conjoin into `_policyFilters` (row-level security narrowing)
 *   2. `scope`  → install on `request.scope` WITHOUT downgrading existing auth
 *
 * Historically each call site re-implemented this logic inline and drifted
 * (action + aggregation routes dropped filters/scope). Every surface now funnels
 * through ONE execution core (`evaluatePermissionOutcome`) + one enforcement
 * point (`applyAuthorizationDecision`) so enforcement can't diverge by transport:
 * the transport-neutral PDP (`evaluatePermissionDecision`) and the HTTP PEP
 * (`evaluateAndApplyPermission`) are thin mappers over the same outcome, not two
 * copies of the run/normalize/catch sequence.
 *
 * @example
 * ```typescript
 * // In a Fastify middleware after running a permission check:
 * const decision = await evaluatePermissionDecision(permissionCheck, ctx);
 * if (decision.effect !== "allow") return reply.code(401).send(...);
 * applyAuthorizationDecision(decision, request);
 * // At this point: request._policyFilters and request.scope are up to date
 * ```
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { arcLog } from "../logger/index.js";
import type { RequestScope } from "../scope/types.js";
import { ArcError } from "../utils/errors.js";
import { conjoinPolicyFilters } from "./filter-merge.js";
import type {
  AuthorizationDecision,
  PermissionCheck,
  PermissionContext,
  UserBase,
} from "./types.js";

const log = arcLog("permissions:enforce");

// ============================================================================
// Normalize — the boolean | AuthorizationDecision seam (arc 2.30)
// ============================================================================

/**
 * A permission check returns either a bare boolean (terse allow/deny sugar) or
 * a full {@link AuthorizationDecision}. There is no legacy `PermissionResult` —
 * `AuthorizationDecision` is arc's single authorization contract.
 */
export type PermissionCheckReturn = boolean | AuthorizationDecision;

/**
 * Normalize a check return into the canonical {@link AuthorizationDecision}.
 * A boolean promotes to `{ effect: "allow" | "deny" }`; a decision passes
 * through. This is the ONE place booleans are promoted, so the rest of the
 * pipeline only ever handles decisions.
 */
export function normalizeToDecision(result: PermissionCheckReturn): AuthorizationDecision {
  return typeof result === "boolean" ? { effect: result ? "allow" : "deny" } : result;
}

// ============================================================================
// Evaluate — the ONE execution core (arc 2.30)
// ============================================================================

/**
 * The classified result of running a permission check exactly once. Every
 * transport maps THIS — the run/normalize/catch sequence lives here and nowhere
 * else, so HTTP, aggregation, MCP, and any future surface can't drift in how
 * they normalize returns or classify throws:
 *
 *   - `decided`    — the check returned (`boolean | AuthorizationDecision`),
 *                    normalized to a decision.
 *   - `structured` — the check threw a deliberate `ArcError` (a discriminable
 *                    `code` + machine-readable `meta`, e.g. a tier gate throwing
 *                    `arc.tier_required`); transports surface it verbatim.
 *   - `failed`     — the check threw anything else. Fail-closed. The neutral PDP
 *                    flattens it to `deny`; HTTP renders 403-even-when-anonymous
 *                    (a broken check is a hard denial, NOT an invitation to
 *                    authenticate) — the transport nuance a flat `deny` can't
 *                    carry, which is exactly why surfaces share the OUTCOME and
 *                    not a pre-flattened decision.
 */
type PermissionOutcome =
  | { status: "decided"; decision: AuthorizationDecision }
  | { status: "structured"; error: ArcError }
  | { status: "failed"; error: unknown };

/**
 * Run a permission check once and classify the result. The single source of the
 * try/normalize/catch sequence — see {@link PermissionOutcome}. Non-`ArcError`
 * throws are logged once here through arc's namespaced logger (a deliberate
 * `ArcError` denial is expected control-flow, not a warning). Pure w.r.t. the
 * request — neither reads a reply nor mutates the request.
 */
async function evaluatePermissionOutcome(
  check: PermissionCheck,
  context: PermissionContext,
): Promise<PermissionOutcome> {
  try {
    return { status: "decided", decision: normalizeToDecision(await check(context)) };
  } catch (err) {
    if (err instanceof ArcError) return { status: "structured", error: err };
    log.warn(
      { err, resource: context.resource, action: context.action },
      "Permission check threw — denying (fail-closed)",
    );
    return { status: "failed", error: err };
  }
}

/**
 * Run a permission check and return a canonical {@link AuthorizationDecision} —
 * the transport-neutral PDP (HTTP, aggregation, MCP, and any future transport).
 * A thin mapper over {@link evaluatePermissionOutcome}:
 *
 *   - a structured `ArcError` is RE-THROWN so the transport surfaces it verbatim
 *     (e.g. a tier gate throwing `arc.tier_required` with machine-readable meta);
 *   - any OTHER throw is fail-closed to a `deny` decision (a broken check must
 *     never fall open to a 500 that skips authorization).
 *
 * Pure w.r.t. the request — it neither reads a reply nor mutates the request.
 * Callers translate the returned decision into their own response mechanism and
 * apply side-effects via {@link applyAuthorizationDecision}. HTTP additionally
 * hardens a *thrown* check to 403-even-when-anonymous — that transport-specific
 * nuance lives in {@link evaluateAndApplyPermission}, not here.
 */
export async function evaluatePermissionDecision(
  check: PermissionCheck,
  context: PermissionContext,
): Promise<AuthorizationDecision> {
  const outcome = await evaluatePermissionOutcome(check, context);
  switch (outcome.status) {
    case "decided":
      return outcome.decision;
    case "structured":
      throw outcome.error;
    case "failed":
      return { effect: "deny" };
  }
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
 * Apply an allowed {@link AuthorizationDecision} to a Fastify request — conjoins
 * the decision's row-level `policy` into `_policyFilters` and conditionally
 * installs the `scope`.
 *
 * **Scope install rule:** only writes `scope` when the current request scope
 * is absent or `public`. This prevents downgrading an already-authenticated
 * request (e.g. Better Auth set `member`, then a permission check returns a
 * narrower `service` scope — the original `member` wins because it came from
 * a more authoritative source).
 *
 * Safe to call with a denied decision — it simply no-ops. Callers should still
 * check `decision.effect` and send an error response before reaching here, but
 * this function tolerates the misuse defensively.
 *
 * This is the enforcement point (PEP) — the ONE place scope + data policy are
 * installed (and the obligation seam lives).
 */
export function applyAuthorizationDecision(
  decision: AuthorizationDecision,
  request: RequestSink,
): void {
  if (decision.effect !== "allow") return;

  // Conjoin the data policy into _policyFilters with AND semantics — a later
  // source can ADD or narrow restrictions, never silently replace an earlier one
  // on the same key (see conjoinPolicyFilters). This is row-level security
  // composition, so overwriting an earlier constraint would be a defense-in-depth
  // hole. `policy` is arc's Mongo-record dialect here; the repository boundary
  // (`toRepositoryFilter`) compiles it to the portable IR per kit.
  if (decision.policy) {
    request._policyFilters = conjoinPolicyFilters(request._policyFilters, decision.policy);
  }

  // Install scope only when we haven't already been authenticated.
  // "public" counts as unauthenticated — everything else is honored as-is.
  if (decision.scope) {
    const current = request.scope;
    if (!current || current.kind === "public") {
      request.scope = decision.scope;
    }
  }

  // Obligation dispatch seam (arc 2.30). A decision does NOT currently carry
  // obligations — audit and field redaction are first-class arc subsystems
  // (`audit: true`; field-level read/write permissions), so there is nothing to
  // run here. This is the single ordered point where an obligation dispatcher
  // WOULD execute if the contract ever gains one; keeping the hook explicit (and
  // empty) means adding it later is registering a dispatcher, not re-plumbing
  // every enforcement surface. Do not fill it without a dispatcher + a real
  // consumer (see designs/authorization-architecture.md).
}

/**
 * @deprecated Renamed to {@link applyAuthorizationDecision} — the contract is an
 * `AuthorizationDecision`, not a `PermissionResult`. This alias is kept for
 * back-compat and will be removed in a future major.
 */
export const applyPermissionResult = applyAuthorizationDecision;

// ============================================================================
// Evaluate + apply (end-to-end permission flow)
// ============================================================================

/**
 * Max length of a decision `reason` string before we fall back to the
 * generic default message. Upstream checks can return arbitrary strings; we
 * clamp to prevent accidental leakage of internal diagnostics or oversized
 * payloads via the 4xx response body.
 */
const MAX_DENIAL_REASON_LENGTH = 100;

/**
 * End-to-end HTTP PEP: evaluates the check through the shared
 * {@link evaluatePermissionOutcome} core, sends a 401/403 response on denial,
 * and applies side-effects on grant. Returns `true` if the caller should
 * continue, `false` if a response has been sent and the caller should return.
 *
 * The HTTP specialization of the ONE evaluation core — it does NOT re-run or
 * re-normalize the check; it only maps the classified outcome onto Fastify:
 *
 *   - `structured` (thrown `ArcError`) → surface verbatim, byte-compatible with
 *     the global error handler (`code`/`message`/`status` + `meta`);
 *   - `failed` (other throw) → 403 EVEN WHEN ANONYMOUS (a broken check is a hard
 *     denial, not a "please authenticate");
 *   - `decided` → allow, or a returned deny → 401 (no user) / 403 (user) with a
 *     clamped `reason`.
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
     * string is used only when the decision's `reason` is absent or exceeds
     * `MAX_DENIAL_REASON_LENGTH`. Defaults to `"Permission denied"` /
     * `"Authentication required"`.
     */
    defaultDenialMessage?: (user: UserBase | null) => string;
  },
): Promise<boolean> {
  const outcome = await evaluatePermissionOutcome(check, context);

  // A check that threw a STRUCTURED ArcError (a discriminable `code` +
  // machine-readable context) is making a deliberate statement — e.g. a tier
  // gate throwing `arc.tier_required` with `{ requiredMode, currentMode }`.
  // Surface it verbatim instead of flattening to a generic "Permission denied",
  // which erased the exact reason a frontend needs to render "requires
  // Enterprise" vs a plain denial. Serialize IDENTICALLY to the global error
  // handler: the structured context is `err.meta` (the `HttpError.meta` mirror
  // of `.details`; `details` is reserved for the field-error ARRAY shape), so
  // this permission-slot path is byte-compatible with the preHandler path — a
  // discriminating client reads the SAME field regardless of which gate fired.
  if (outcome.status === "structured") {
    const err = outcome.error;
    reply.code(err.status).send({
      code: err.code,
      message: err.message,
      status: err.status,
      ...(err.meta ? { meta: err.meta } : {}),
    });
    return false;
  }

  // A NON-ArcError throw is fail-closed to 403 regardless of authentication. A
  // broken check must not read as "just log in" (which a 401 invites), nor fall
  // open to a 500 that skips authorization. This 403-even-when-anonymous is the
  // transport nuance the neutral `deny` decision can't express — hence mapping
  // the outcome here rather than the pre-flattened decision.
  if (outcome.status === "failed") {
    reply.code(403).send({
      code: "arc.forbidden",
      message: "Permission denied",
      status: 403,
    });
    return false;
  }

  // Decided → shape denial, or apply side-effects on grant.
  const { decision } = outcome;
  if (decision.effect !== "allow") {
    const defaultMsg =
      opts?.defaultDenialMessage?.(context.user) ??
      (context.user ? "Permission denied" : "Authentication required");
    const reason =
      decision.reason && decision.reason.length <= MAX_DENIAL_REASON_LENGTH
        ? decision.reason
        : defaultMsg;
    const status = context.user ? 403 : 401;
    reply.code(status).send({
      code: context.user ? "arc.forbidden" : "arc.unauthorized",
      message: reason,
      status,
    });
    return false;
  }

  // Grant → apply side-effects (data policy + scope).
  applyAuthorizationDecision(decision, request);
  return true;
}
