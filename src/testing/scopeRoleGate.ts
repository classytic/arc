/**
 * `scopeRoleGate` — the ONE role gate for package tests.
 *
 * ## Why this is in the framework
 *
 * Nine `@classytic/arc-*` packages had their own copy of this helper, and all nine were
 * wrong in the same two ways:
 *
 * 1. They read the role from an `x-role` HEADER and INSTALLED the request scope from
 *    inside the check — so identity came from the caller's own claim, and it arrived too
 *    late for arc's tenant-filtering pipeline to see it.
 * 2. They returned the pre-2.30 `{ granted: boolean }` shape, which is neither a boolean
 *    nor an `AuthorizationDecision`. It passed through `normalizeToDecision` untouched,
 *    arrived with `effect: undefined`, and was read as DENY — the gate said yes and arc
 *    refused anyway. Nothing type-errored, because the gate is cast at the call site.
 *
 * Two of the nine had already been fixed by hand, each with a docstring describing this
 * exact discovery. The knowledge reached neither of the other seven. That is the whole
 * case for a shared seam: a copy does not fail, it diverges.
 *
 * A test role gate is generic — "does the verified scope hold one of these roles" has no
 * domain in it — so it belongs here, beside the contract it depends on.
 *
 * Identity itself comes from `testActorHeaders()` + `bootModuleApp`'s authenticator
 * (see `testActor.ts`), which puts the scope where production puts it. This stays a pure
 * predicate over what arc verified.
 *
 * Kept in its own module rather than beside `testActor.ts` so the two can be edited
 * independently.
 */

import { requireOrgRole } from "../permissions/scope.js";
import type { PermissionCheck } from "../permissions/types.js";

/**
 * Grants iff the caller is an org member holding one of `allowed` as an ORG role.
 *
 * This is `requireOrgRole` under a name package tests reach for — deliberately a
 * delegation, not a reimplementation. It previously read `scope.userRoles` while
 * requiring an organization, so it disagreed with production for any actor whose
 * global and org roles differ: given
 * `{ roles: ["employee"], orgRoles: ["manager"], organizationId: "org-1" }`,
 * `requireOrgRole("manager")` allowed and this denied. The tests never caught it
 * because `scopeFromTestActor` defaults `orgRoles` to `roles`, making the two
 * dimensions identical for the common actor.
 *
 * Delegating also inherits the semantics a hand-rolled gate kept missing:
 * elevated scopes pass, and a service (API-key) identity is refused with a
 * message naming `requireServiceScope` instead of silently failing a role test.
 *
 * **Pair it with an org-bearing actor.** `testActorHeaders('manager', ORG)`
 * yields a `member` scope and passes; `testActorHeaders('manager')` yields an
 * `authenticated` scope with no tenant, which is refused — arc's generated CRUD
 * filters by tenant, so a gate that waves a tenant-less request through is how a
 * green test reads another org's rows.
 */
export function scopeRoleGate(...allowed: string[]): PermissionCheck {
  return requireOrgRole(...allowed);
}
