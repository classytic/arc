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
 * - `authenticated` — the check reads request-time facts (custom auth, service
 *   scope, ownership, scope-context, grants) that no static analysis can decide;
 *   the definitive answer is computed per request. Treat as "server decides".
 */
export type PermissionRequirement =
  | { readonly kind: "public" }
  | { readonly kind: "roles"; readonly roles: readonly string[] }
  | { readonly kind: "authenticated" };

/**
 * Extract a check's static requirement from its `PermissionCheckMeta`. Public
 * wins; then the union of platform + org roles a role gate declares; otherwise
 * "authenticated" (auth-required / custom / request-time checks).
 */
export function describePermission(check: PermissionCheck): PermissionRequirement {
  if (check._isPublic) return { kind: "public" };
  const roles = [...(check._roles ?? []), ...(check._orgRoles ?? [])];
  if (roles.length > 0) return { kind: "roles", roles };
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
  principal?: { roles?: readonly string[]; orgRoles?: readonly string[] },
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
  // roles
  if (!principal) {
    return {
      decision: "conditional",
      reason: `requires one of: ${requirement.roles.join(", ")}`,
      requirement,
    };
  }
  const held = new Set([...(principal.roles ?? []), ...(principal.orgRoles ?? [])]);
  const matched = requirement.roles.filter((r) => held.has(r));
  return matched.length > 0
    ? { decision: "allow", reason: `granted via role(s): ${matched.join(", ")}`, requirement }
    : { decision: "deny", reason: `requires one of: ${requirement.roles.join(", ")}`, requirement };
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
