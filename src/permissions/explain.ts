/**
 * Static authorization analysis (arc 2.30).
 *
 * The payoff of decisions-as-data + immutable `PermissionCheckMeta`: you can
 * answer "who can do X, and why" WITHOUT running a request. Combinators
 * (`allOf`/`anyOf`) already aggregate their children's meta, so these read a
 * single introspectable requirement off any composed check.
 *
 * Two primitives:
 *   - {@link describePermission} — the static requirement (public / roles /
 *     authenticated). The building block for a permission matrix, an OpenAPI
 *     security section, or an MCP tool description.
 *   - {@link explainAccess} — evaluate that requirement against a principal's
 *     roles: `allow` / `deny` are DEFINITIVE from metadata; `conditional` means
 *     the check reads request-time state (custom auth, service scope, ownership,
 *     grants) so the real decision happens per request — never guessed here.
 *
 * This is the framework-owned version of the introspection hosts hand-roll (e.g.
 * a `/permissions/matrix` endpoint): one source of truth for what a gate
 * requires, so a UI's "can I?" and the server's actual enforcement can't drift.
 */

import type { PermissionCheck } from "./types.js";

/**
 * The statically-known requirement of a permission check.
 *
 * - `public` — `allowPublic()`; anyone passes.
 * - `roles` — grants if the caller holds ANY of these (platform OR org roles,
 *   unioned — matches how `requireRoles`/`requireOrgRole`/`anyOf` compose).
 * - `scoped` — grants only within a caller SCOPE dimension (`_scopeContext`,
 *   e.g. `{ branchRole: "head_office" }`), optionally combined with `roles`. The
 *   scope dimensions are known statically even though their per-request VALUES
 *   aren't, so a consumer that holds the caller's scope (a FE that knows the
 *   active branch's role) can decide it client-side — the piece a flat `roles`
 *   requirement could not express.
 * - `authenticated` — the check reads request-time facts (custom auth, service
 *   scope, ownership, grants) that no static analysis can decide; the definitive
 *   answer is computed per request. Treat as "server decides".
 */
export type PermissionRequirement =
  | { readonly kind: "public" }
  | {
      readonly kind: "roles";
      readonly roles: readonly string[];
      /**
       * `true` when these roles are NECESSARY but not SUFFICIENT — the gate is an
       * `allOf(...)` that also carries an opaque runtime branch (ownership /
       * custom / dynamic / flow-mode …). A role MATCH is then `conditional`, not a
       * definitive `allow`; a MISMATCH is still a definitive `deny`.
       */
      readonly conditional?: boolean;
    }
  | {
      readonly kind: "scoped";
      /** Required scope dimensions: `value` string = must equal; `undefined` = must be present. */
      readonly scope: Readonly<Record<string, string | undefined>>;
      /** Roles ALSO required alongside the scope (union of platform + org roles), if any. */
      readonly roles?: readonly string[];
      /** See `roles.conditional` — the composite also has an opaque/contradictory branch. */
      readonly conditional?: boolean;
    }
  | { readonly kind: "authenticated" };

/**
 * Extract a check's static requirement from its `PermissionCheckMeta`. Public
 * wins; then a scope-context gate (optionally with roles); then the union of
 * platform + org roles a role gate declares; otherwise "authenticated"
 * (auth-required / custom / request-time checks). An `allOf` that couldn't be
 * fully captured statically carries `conditional: true` (see `_conditional`).
 */
export function describePermission(check: PermissionCheck): PermissionRequirement {
  if (check._isPublic) return { kind: "public" };
  const roles = [...(check._roles ?? []), ...(check._orgRoles ?? [])];
  const scope = check._scopeContext;
  const conditional = check._conditional ? true : undefined;
  if (scope && Object.keys(scope).length > 0) {
    return roles.length > 0
      ? { kind: "scoped", scope, roles, conditional }
      : { kind: "scoped", scope, conditional };
  }
  if (roles.length > 0) return { kind: "roles", roles, conditional };
  return { kind: "authenticated" };
}

/** Result of {@link explainAccess}. */
export interface AccessExplanation {
  /**
   * `allow` / `deny` are DEFINITIVE from static metadata (public, or a role
   * match against the supplied principal). `conditional` means the gate reads
   * request-time state, so the real decision is made per request — this is not a
   * denial, it is "cannot be determined statically".
   */
  decision: "allow" | "deny" | "conditional";
  /** Human-readable rationale, safe to surface in a UI or an audit report. */
  reason: string;
  /** The check's static requirement (the same value {@link describePermission} returns). */
  requirement: PermissionRequirement;
}

/**
 * Explain whether a principal (by roles) passes a permission check, from static
 * metadata alone — for permission-matrix UIs, docs, and audits. Omit `principal`
 * to get the requirement-only view (roles → `conditional`).
 *
 * @example
 * explainAccess(requireRoles("admin"), { roles: ["editor"] })
 * // → { decision: "deny", reason: "requires one of: admin", requirement: { kind: "roles", roles: ["admin"] } }
 */
export function explainAccess(
  check: PermissionCheck,
  principal?: {
    roles?: readonly string[];
    orgRoles?: readonly string[];
    /** The caller's scope-context values (e.g. `{ branchRole: "head_office" }`) — supply to decide a `scoped` gate. */
    scope?: Readonly<Record<string, string | undefined>>;
  },
): AccessExplanation {
  const requirement = describePermission(check);

  if (requirement.kind === "public") {
    return { decision: "allow", reason: "public — no authentication required", requirement };
  }
  if (requirement.kind === "authenticated") {
    return {
      decision: "conditional",
      reason: "requires authentication; decided per request",
      requirement,
    };
  }

  const held = new Set([...(principal?.roles ?? []), ...(principal?.orgRoles ?? [])]);

  if (requirement.kind === "scoped") {
    const scopeReason = describeScope(requirement.scope);
    const rolesReason = requirement.roles?.length
      ? `role(s) ${requirement.roles.join(", ")} + `
      : "";
    // A missing co-required role is a definitive deny even before scope.
    if (requirement.roles?.length && principal && !requirement.roles.some((r) => held.has(r))) {
      return { decision: "deny", reason: `requires ${rolesReason}${scopeReason}`, requirement };
    }
    // Without the caller's scope the deciding fact is unknown — per request.
    if (!principal?.scope) {
      return {
        decision: "conditional",
        reason: `requires ${rolesReason}${scopeReason}`,
        requirement,
      };
    }
    // A scope MISMATCH is a definitive deny — the necessary scope failed
    // (contradictory-conjunction gates land here for at least one branch too).
    const scopeOk = Object.entries(requirement.scope).every(([dim, val]) =>
      val === undefined ? principal.scope?.[dim] !== undefined : principal.scope?.[dim] === val,
    );
    if (!scopeOk) {
      return { decision: "deny", reason: `requires ${rolesReason}${scopeReason}`, requirement };
    }
    // Scope (and role) satisfied. If an opaque branch remains, holding them is
    // necessary but not sufficient → conditional; otherwise a genuine allow.
    if (requirement.conditional) {
      return {
        decision: "conditional",
        reason: `in scope ${scopeReason}; additional runtime conditions apply`,
        requirement,
      };
    }
    return { decision: "allow", reason: `granted in scope: ${scopeReason}`, requirement };
  }

  // roles
  const rolesText = `requires one of: ${requirement.roles.join(", ")}`;
  if (!principal) {
    return { decision: "conditional", reason: rolesText, requirement };
  }
  const matched = requirement.roles.filter((r) => held.has(r));
  if (matched.length === 0) {
    // A necessary role is absent — definitive deny whether or not the composite
    // has other conditions (the conjunction can't pass without the role).
    return { decision: "deny", reason: rolesText, requirement };
  }
  // Role held. If the gate is an `allOf` with an opaque runtime branch, holding
  // the role is necessary but NOT sufficient — the ownership/custom/dynamic check
  // still decides per request, so this is `conditional`, not a static `allow`.
  if (requirement.conditional) {
    return {
      decision: "conditional",
      reason: `has role(s) ${matched.join(", ")}; additional runtime conditions apply`,
      requirement,
    };
  }
  return { decision: "allow", reason: `granted via role(s): ${matched.join(", ")}`, requirement };
}

/** Render a scope-context requirement as a readable clause: `branchRole=head_office`. */
function describeScope(scope: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(scope)
    .map(([dim, val]) => (val === undefined ? `${dim} (any)` : `${dim}=${val}`))
    .join(", ");
}

/**
 * Introspect a whole permission map (`{ list, get, create, ... }` or any
 * action→check record) into `action → requirement`. The reusable core of a
 * `/permissions/matrix` endpoint or an access audit — framework-owned, so a host
 * never hand-rolls `(check as any)._roles` peeking. Undefined slots (a CRUD op
 * with no gate = public-by-omission) surface as `public` so the inventory is
 * honest about what's exposed.
 */
export function describePermissionMap(
  permissions: Readonly<Record<string, PermissionCheck | undefined>>,
): Record<string, PermissionRequirement> {
  const out: Record<string, PermissionRequirement> = {};
  for (const [action, check] of Object.entries(permissions)) {
    out[action] = check ? describePermission(check) : { kind: "public" };
  }
  return out;
}

/**
 * The public attack surface of a permission map — the actions reachable with NO
 * authentication (explicit `allowPublic()` or public-by-omission). Empty is the
 * healthy default for a protected resource; a non-empty list is what a
 * "what's exposed?" audit report should show.
 */
export function collectPublicSurface(
  permissions: Readonly<Record<string, PermissionCheck | undefined>>,
): string[] {
  return Object.entries(describePermissionMap(permissions))
    .filter(([, req]) => req.kind === "public")
    .map(([action]) => action);
}
