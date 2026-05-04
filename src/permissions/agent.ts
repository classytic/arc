/**
 * Agent-Auth Permission Helpers — DPoP + capability mandates for AI-agent flows
 *
 * Three checks for the 2025 agent-authorization stack (AP2 / Stripe x402 /
 * MCP authorization / RFC 9700 / RFC 9449 / RFC 9728):
 *
 * - `requireDPoP()`           — token must be sender-constrained (RFC 9449)
 * - `requireMandate(cap, …)`  — capability mandate must authorize this action
 * - `requireAgentScope(opts)` — composite gate: service identity + mandate + DPoP
 *
 * Arc reads `request.scope.mandate` and `request.scope.dpopJkt` populated by
 * your `authenticate` callback. Arc does **not** parse mandate JWTs/VCs or
 * verify DPoP proofs — that's a 1-2 line `jose` call in your authenticator.
 * Arc validates *what's already proved* against the action being attempted.
 *
 * @example
 * ```typescript
 * import { requireDPoP, requireMandate, requireAgentScope } from '@classytic/arc/permissions';
 *
 * defineResource({
 *   name: 'invoice',
 *   permissions: {
 *     pay: requireAgentScope({
 *       capability: 'payment.charge',
 *       requireDPoP: true,
 *       validateAmount: (ctx, mandate) =>
 *         typeof ctx.data?.amount === 'number' && ctx.data.amount <= (mandate.cap ?? 0),
 *       audience: (ctx) => `invoice:${ctx.params?.id}`,
 *     }),
 *   },
 * });
 * ```
 */

import {
  getDPoPJkt,
  getMandate,
  getRequestScope as getScope,
  isElevated,
  isService,
  type Mandate,
} from "../scope/types.js";
import type { PermissionCheck, PermissionContext } from "./types.js";

/** Default grace window for mandate `expiresAt` — accommodates clock skew. */
const DEFAULT_TTL_GRACE_MS = 30_000;

/**
 * Require a sender-constrained credential — the inbound token MUST carry a
 * DPoP proof (RFC 9449) bound to a known key. Arc reads `scope.dpopJkt` (the
 * JWK SHA-256 thumbprint per RFC 7638); your `authenticate` function performs
 * the cryptographic `jose.dpop.verify(...)` and sets the field on success.
 *
 * **Pass behavior:**
 * - `service` scope where `dpopJkt` is set → grant
 * - `elevated` scope → grant (platform admin bypass)
 * - Anything else → deny with a clear reason
 *
 * Use for high-value endpoints where bearer-token replay must be impossible:
 * payment charges, data exports, account-takeover-class admin actions.
 *
 * @example
 * ```typescript
 * permissions: { charge: allOf(requireServiceScope('payment.write'), requireDPoP()) }
 * ```
 */
export function requireDPoP<TDoc = Record<string, unknown>>(): PermissionCheck<TDoc> {
  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

    if (isElevated(scope)) return true;

    if (!isService(scope)) {
      return {
        granted: false,
        reason:
          "DPoP-bound service identity required. Configure your authenticate callback " +
          "to set scope.dpopJkt after verifying the DPoP proof header (RFC 9449).",
      };
    }

    const jkt = getDPoPJkt(scope);
    if (!jkt) {
      return {
        granted: false,
        reason:
          "Sender-constrained credential required (DPoP). " +
          "Inbound token is bearer; replay-resistance is mandatory on this endpoint.",
      };
    }

    return true;
  };
  check._dpopRequired = true;
  return check;
}

/**
 * Options for `requireMandate(capability, opts)`.
 */
export interface RequireMandateOptions<TDoc = Record<string, unknown>> {
  /**
   * Custom validator for the mandate's numeric ceiling against the inbound
   * request. Arc passes the request body / params; you decide whether the
   * action stays within the mandate's `cap`.
   *
   * Return `true` to accept, `false` (or a string reason) to deny. When
   * omitted, arc skips amount validation — useful for boolean-capability
   * mandates where presence of the mandate IS the authorization (no cap).
   *
   * @example
   * ```typescript
   * validateAmount: (ctx, mandate) => {
   *   const amount = (ctx.data as { amount?: number })?.amount ?? 0;
   *   if (amount <= (mandate.cap ?? 0)) return true;
   *   return `Amount ${amount} exceeds mandate cap ${mandate.cap}`;
   * }
   * ```
   */
  validateAmount?: (ctx: PermissionContext<TDoc>, mandate: Readonly<Mandate>) => boolean | string;
  /**
   * Resource the mandate must be bound to (`Mandate.audience`). Pass a
   * static value or a function that derives it from the request (typically
   * `ctx.params.id`). When set and the mandate's `audience` doesn't match,
   * the request is denied — prevents a payment-mandate for invoice A being
   * replayed against invoice B.
   */
  audience?: string | ((ctx: PermissionContext<TDoc>) => string | undefined);
  /**
   * Clock-skew tolerance for `Mandate.expiresAt`, in milliseconds.
   * Default `30_000` (30s).
   */
  ttlGraceMs?: number;
  /**
   * When `true`, `elevated` scope is NOT allowed to bypass the mandate check.
   * Defaults to `false` — platform admins normally bypass everything.
   * Set when you genuinely want "even an admin needs a mandate" semantics
   * (audited break-glass actions, regulated payment flows).
   */
  noElevatedBypass?: boolean;
}

/**
 * Require a capability mandate (AP2 / x402 / MCP authorization) that
 * authorizes the action being attempted.
 *
 * The mandate is set on `request.scope.mandate` by your authenticate function
 * after verifying the inbound mandate JWT/VC. This check validates that the
 * presented mandate covers the requested capability, hasn't expired, is bound
 * to the right resource (when `audience` opt is set), and respects the
 * mandate's numeric ceiling (when `validateAmount` opt is set).
 *
 * **Pass behavior:**
 * - `elevated` scope → grant unless `noElevatedBypass: true`
 * - `service` scope with mandate matching `capability`, not expired, and
 *   passing `validateAmount` + `audience` checks → grant
 * - Anything else → deny with a precise reason
 *
 * Pair with `requireDPoP()` for replay-resistance, or use the bundled
 * `requireAgentScope(...)` to declare both at once.
 *
 * @example
 * ```typescript
 * // Single payment charge — amount must fit the mandate's cap
 * permissions: {
 *   pay: requireMandate('payment.charge', {
 *     validateAmount: (ctx, m) => (ctx.data as { amount: number }).amount <= (m.cap ?? 0),
 *     audience: (ctx) => `invoice:${ctx.params?.id}`,
 *   }),
 * }
 *
 * // Boolean capability — presence of mandate is the gate
 * permissions: {
 *   exportData: requireMandate('data.export'),
 * }
 * ```
 */
export function requireMandate<TDoc = Record<string, unknown>>(
  capability: string,
  opts: RequireMandateOptions<TDoc> = {},
): PermissionCheck<TDoc> {
  if (!capability || typeof capability !== "string") {
    throw new Error(
      "requireMandate(capability) requires a non-empty capability string (e.g. 'payment.charge')",
    );
  }

  const ttlGrace = opts.ttlGraceMs ?? DEFAULT_TTL_GRACE_MS;
  const noElevatedBypass = opts.noElevatedBypass === true;

  const check: PermissionCheck<TDoc> = (ctx) => {
    const scope = getScope(ctx.request);

    if (isElevated(scope) && !noElevatedBypass) return true;

    const mandate = getMandate(scope);
    if (!mandate) {
      return {
        granted: false,
        reason:
          `Capability mandate required (${capability}). ` +
          "Configure your authenticate callback to populate request.scope.mandate " +
          "after verifying the mandate JWT/VC.",
      };
    }

    if (mandate.capability !== capability) {
      return {
        granted: false,
        reason: `Mandate authorizes "${mandate.capability}", not "${capability}"`,
      };
    }

    if (mandate.expiresAt !== undefined && Date.now() > mandate.expiresAt + ttlGrace) {
      return {
        granted: false,
        reason: `Mandate expired at ${new Date(mandate.expiresAt).toISOString()}`,
      };
    }

    if (opts.audience) {
      const required = typeof opts.audience === "function" ? opts.audience(ctx) : opts.audience;
      if (required && mandate.audience && mandate.audience !== required) {
        return {
          granted: false,
          reason: `Mandate is bound to "${mandate.audience}", not "${required}"`,
        };
      }
      if (required && !mandate.audience) {
        return {
          granted: false,
          reason: `Mandate must be bound to "${required}" (no audience claim)`,
        };
      }
    }

    if (opts.validateAmount) {
      const result = opts.validateAmount(ctx, mandate);
      if (result !== true) {
        return {
          granted: false,
          reason:
            typeof result === "string"
              ? result
              : `Action exceeds mandate cap ${mandate.cap}${
                  mandate.currency ? ` ${mandate.currency}` : ""
                }`,
        };
      }
    }

    return true;
  };
  check._mandateCapability = capability;
  return check;
}

/**
 * Options for `requireAgentScope(opts)`.
 */
export interface RequireAgentScopeOptions<TDoc = Record<string, unknown>>
  extends RequireMandateOptions<TDoc> {
  /**
   * Capability the mandate must authorize (e.g., `payment.charge`,
   * `inbox.send`). Required.
   */
  capability: string;
  /**
   * When `true`, the inbound credential must also be DPoP-bound (RFC 9449).
   * Defaults to `true` — sender-constrained credentials are the standard
   * for high-value agent flows. Set `false` only when you intentionally
   * accept bearer tokens (rare; usually a regression).
   */
  requireDPoP?: boolean;
  /**
   * Optional OAuth-style scope strings the service identity must hold in
   * addition to the mandate (e.g., `['payment.write']`). Pairs with the
   * mandate's narrower per-request authorization — scopes answer "ever
   * allowed?", mandate answers "right now?".
   */
  scopes?: readonly string[];
}

/**
 * Composite gate for AI-agent / M2M flows on protected resources.
 *
 * Bundles the three things every high-value agent endpoint needs:
 * 1. **Service identity** — `scope.kind === 'service'` with `clientId`
 * 2. **Capability mandate** — narrows what *this request* may do
 * 3. **DPoP binding** — credential cannot be replayed from a different key
 *
 * Use this instead of hand-composing `allOf(requireServiceScope(...),
 * requireMandate(...), requireDPoP())` — fewer ways to misconfigure, one
 * meta-tag downstream tools (audit, MCP, OpenAPI) can read.
 *
 * @example
 * ```typescript
 * import { requireAgentScope } from '@classytic/arc/permissions';
 *
 * defineResource({
 *   name: 'invoice',
 *   actions: {
 *     pay: {
 *       handler: payInvoice,
 *       permissions: requireAgentScope({
 *         capability: 'payment.charge',
 *         scopes: ['payment.write'],
 *         requireDPoP: true,
 *         audience: (ctx) => `invoice:${ctx.params?.id}`,
 *         validateAmount: (ctx, m) => (ctx.data as { amount: number }).amount <= (m.cap ?? 0),
 *       }),
 *     },
 *   },
 * });
 * ```
 */
export function requireAgentScope<TDoc = Record<string, unknown>>(
  opts: RequireAgentScopeOptions<TDoc>,
): PermissionCheck<TDoc> {
  const { capability, scopes, requireDPoP: needsDPoP = true, ...mandateOpts } = opts;

  if (!capability) {
    throw new Error("requireAgentScope({ capability }) is required");
  }

  // Compose the leaf checks. Each leaf already handles `elevated` bypass,
  // service-identity requirement, and its own metadata tagging — the
  // composite just sequences them and reports the first denial.
  const mandateCheck = requireMandate<TDoc>(capability, mandateOpts);
  const dpopCheck = needsDPoP ? requireDPoP<TDoc>() : null;
  const requiredScopes = scopes && scopes.length > 0 ? [...scopes] : null;

  const check: PermissionCheck<TDoc> = async (ctx) => {
    const scope = getScope(ctx.request);

    // Elevated bypass — same posture as the underlying mandate check, kept
    // here so we can short-circuit the OAuth-scope check for platform admins.
    if (isElevated(scope) && !mandateOpts.noElevatedBypass) return true;

    // Service-identity precondition. Done before delegating so a logged-in
    // human gets the precise "service identity required" reason rather than
    // the leaf's "mandate required" message — clearer error for the actual
    // misconfiguration, even though the leaves would also deny.
    if (!isService(scope)) {
      return {
        granted: false,
        reason:
          "Service identity required (machine principal). " +
          "Agent flows must authenticate as a service, not a logged-in user.",
      };
    }

    if (requiredScopes) {
      const granted = scope.scopes ?? [];
      const hasAny = requiredScopes.some((s) => granted.includes(s));
      if (!hasAny) {
        return {
          granted: false,
          reason: `Service identity is missing required OAuth scope(s): ${requiredScopes.join(", ")}`,
        };
      }
    }

    // Delegate to the leaves — each returns true | PermissionResult. We
    // surface the first denial verbatim so the reason string maps 1:1 to
    // the underlying helper's vocabulary.
    const mandateResult = await mandateCheck(ctx);
    if (mandateResult !== true) {
      return typeof mandateResult === "object"
        ? mandateResult
        : { granted: false, reason: "Mandate check failed" };
    }

    if (dpopCheck) {
      const dpopResult = await dpopCheck(ctx);
      if (dpopResult !== true) {
        return typeof dpopResult === "object"
          ? dpopResult
          : { granted: false, reason: "DPoP binding required" };
      }
    }

    return true;
  };
  check._agentScope = { capability, scopes: requiredScopes ?? undefined, dpop: needsDPoP };
  return check;
}
