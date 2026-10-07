/**
 * Permission Core — universal permission primitives.
 *
 * Auth/role/ownership checks and the combinators (`allOf`, `anyOf`, `not`,
 * `when`, `denyAll`) that compose them. Scope-bound checks live in
 * `./scope.js`; the dynamic matrix lives in `./dynamic.js`.
 */

import type { RequestScope } from "../scope/types.js";
import { getUserId as getScopeUserId, isElevated, isMember } from "../scope/types.js";
import { normalizeToDecision } from "./authorizationDecision.js";
import { scopeOf } from "./context.js";
import { conjoinPolicyFilters } from "./filter-merge.js";
import type {
  AuthorizationDecision,
  DataPolicy,
  PermissionCheck,
  PermissionContext,
} from "./types.js";
import { getUserRoles } from "./types.js";

// ============================================================================
// Decision constructors (arc v3) — the canonical way a check expresses intent
// ============================================================================

/**
 * Build an `allow` {@link AuthorizationDecision}, optionally attaching a row-level
 * `policy` and/or a `scope` to install. The idiomatic "grant" return for arc
 * 2.30 checks (parallels Cedar's `permit`).
 *
 * @example
 * return allow();                                  // simple grant
 * return allow({ policy: { ownerId: userId } });   // grant + row policy
 */
export function allow(extra?: Omit<AuthorizationDecision, "effect">): AuthorizationDecision {
  return extra ? { effect: "allow", ...extra } : { effect: "allow" };
}

/**
 * Build a `deny` {@link AuthorizationDecision} with an optional human-readable
 * reason (parallels Cedar's `forbid`). The idiomatic "refuse" return.
 */
export function deny(reason?: string): AuthorizationDecision {
  return reason ? { effect: "deny", reason } : { effect: "deny" };
}

/**
 * Normalize a `string | [readonly string[]]` rest-args tuple into a single
 * `readonly string[]`. Lets a permission helper accept BOTH variadic and
 * array call shapes from one overload signature.
 *
 * Used by `requireOrgRole`, `requireServiceScope`, etc. **Not** used by
 * `requireRoles` — that helper has a richer overload signature with an
 * options object and stays on its own normalization path.
 */
export function normalizeVariadicOrArray(args: string[] | [readonly string[]]): readonly string[] {
  return Array.isArray(args[0]) ? args[0] : (args as string[]);
}

/**
 * The row policy an `allowPublic` gate applies to the callers it admits: a
 * filter, or a function of the request that returns one.
 *
 * The function form is the scope-aware one — it sees the caller, so anonymous
 * visitors, the row's author and staff can each get a different filter from ONE
 * gate. Return `{}` to admit a caller unrestricted (e.g. staff); returning
 * nothing is treated as a bug, not as "no filter" (see {@link allowPublic}).
 */
export type PublicPolicy<TDoc = Record<string, unknown>> =
  | DataPolicy
  | ((ctx: PermissionContext<TDoc>) => DataPolicy | Promise<DataPolicy>);

/** Options for {@link allowPublic}. */
export interface AllowPublicOptions<TDoc = Record<string, unknown>> {
  /**
   * Narrow what anyone admitted by this gate can read or write. Enforced where
   * every other row policy is: ANDed into the repository query for `list`, into
   * the compound lookup for `get` / `update` / `delete`, into aggregations, and
   * per event on realtime feeds. A caller cannot widen it with a query
   * parameter — `?status=hidden` is conjoined with the policy, not substituted
   * for it.
   */
  policy?: PublicPolicy<TDoc>;
}

/** A non-null, non-array object — the only shape a row policy can take. */
function isPolicyObject(value: unknown): value is DataPolicy {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Own keys, symbol-keyed included (a branded adapter-native filter is symbol-keyed). */
function hasPolicyKeys(policy: DataPolicy): boolean {
  return Object.keys(policy).length > 0 || Object.getOwnPropertySymbols(policy).length > 0;
}

/**
 * Allow public access (no authentication required) — optionally row-filtered.
 *
 * Without options, anyone passes and sees everything the query asks for.
 *
 * With `policy`, anyone still passes, but only the rows the policy admits are
 * readable (or writable). This is the declarative form of a check that returns
 * `allow({ policy })`, and it exists because the hand-written form has a trap:
 * a check function is treated as PROTECTED unless it carries `_isPublic`, so a
 * custom "public, but only published rows" check that forgets to set the flag
 * answers every anonymous visitor with a 401 — the public page silently
 * becomes a login wall. `allowPublic({ policy })` sets it for you.
 *
 * Fail-closed on both ends:
 *  - a STATIC policy must be a non-empty object — `{}` filters nothing and is
 *    almost certainly a mistake, so it throws at definition time (use
 *    `allowPublic()` for an unrestricted gate);
 *  - a RESOLVER that returns anything but an object throws per request, which
 *    arc answers as a 403 for everyone. A forgotten branch that falls off the
 *    end of the function must not quietly mean "no filter". Return `{}` when a
 *    caller genuinely should be unrestricted.
 *
 * Composing: inside `anyOf`, the FIRST granting branch wins, and a public
 * branch grants everyone — so `anyOf(allowPublic({ policy }), requireRoles("admin"))`
 * filters admins too. Put the privileged branch first, or use the resolver
 * form and return `{}` for staff.
 *
 * @example
 * ```typescript
 * // Strangers see only published reviews, whatever filter they send.
 * list: allowPublic({ policy: { status: { $in: ["published", "flagged"] } } }),
 *
 * // Scope-aware: the author also sees their own pending review; staff see all.
 * list: allowPublic({
 *   policy: (ctx) => {
 *     const scope = scopeOf(ctx);
 *     if (isElevated(scope)) return {};
 *     const visible = { status: { $in: ["published", "flagged"] } };
 *     const userId = getUserId(scope);
 *     return userId ? { $or: [visible, { authorId: userId }] } : visible;
 *   },
 * }),
 * ```
 */
export function allowPublic<TDoc = Record<string, unknown>>(
  options?: AllowPublicOptions<TDoc>,
): PermissionCheck<TDoc> {
  const policy = options?.policy;

  if (policy === undefined) {
    const check: PermissionCheck<TDoc> = () => true;
    check._isPublic = true;
    return check;
  }

  let check: PermissionCheck<TDoc>;
  if (typeof policy === "function") {
    check = async (ctx) => {
      const resolved: unknown = await policy(ctx);
      if (!isPolicyObject(resolved)) {
        throw new Error(
          `[arc] allowPublic({ policy }) resolver returned ${
            resolved === null ? "null" : Array.isArray(resolved) ? "an array" : typeof resolved
          } for '${ctx.resource}:${ctx.action}'. Return a filter object, or {} to admit this ` +
            "caller unrestricted. Returning nothing is refused rather than read as 'no filter'.",
        );
      }
      return hasPolicyKeys(resolved) ? allow({ policy: resolved }) : allow();
    };
  } else {
    if (!isPolicyObject(policy)) {
      throw new Error(
        "[arc] allowPublic({ policy }) expects a filter object or a function returning one, got " +
          `${policy === null ? "null" : Array.isArray(policy) ? "an array" : typeof policy}.`,
      );
    }
    if (!hasPolicyKeys(policy)) {
      throw new Error(
        "[arc] allowPublic({ policy: {} }) filters nothing. Use allowPublic() for an unrestricted " +
          "public gate, or give the policy a constraint.",
      );
    }
    // Shared across requests safely: enforcement conjoins it into a fresh
    // object per request (`conjoinPolicyFilters`) and never mutates it.
    check = () => allow({ policy });
  }

  check._isPublic = true;
  check._rowPolicy = true;
  return check;
}

/**
 * Require authentication (any authenticated user).
 *
 * @example
 * ```typescript
 * permissions: {
 *   create: requireAuth(),
 *   update: requireAuth(),
 * }
 * ```
 */
export function requireAuth(): PermissionCheck {
  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return deny("Authentication required");
    }
    return true;
  };
  // Pure identity gate — no row-level/environmental condition. Marked so `allOf`
  // doesn't treat it as an opaque branch (see the conditional-taint logic there).
  check._requiresAuth = true;
  return check;
}

/**
 * Require one of the specified roles. Checks BOTH platform roles
 * (`user.role`) AND organization roles (`scope.orgRoles`) by default —
 * passing in either layer grants access. Elevated scope always passes.
 *
 * Accepts EITHER variadic strings OR a single readonly array — both forms
 * produce identical behavior.
 *
 * @example
 * ```typescript
 * requireRoles('admin')
 * requireRoles('admin', 'editor')
 * requireRoles(['admin', 'editor'])
 * requireRoles(['admin'], { bypassRoles: ['superadmin'] })
 * requireRoles(['admin'], { includeOrgRoles: false })  // platform-only
 * ```
 *
 * For org-only role checks, prefer `requireOrgRole('admin')`.
 */
export function requireRoles(role: string, ...rest: string[]): PermissionCheck;
export function requireRoles(
  roles: readonly string[],
  options?: {
    bypassRoles?: readonly string[];
    /**
     * Also check org membership roles (`scope.orgRoles`) when in org context.
     * Default: `true`. Set to `false` to check only platform roles.
     */
    includeOrgRoles?: boolean;
  },
): PermissionCheck;
export function requireRoles(
  rolesOrFirst: string | readonly string[],
  optionsOrSecond?:
    | string
    | {
        bypassRoles?: readonly string[];
        includeOrgRoles?: boolean;
      },
  ...rest: string[]
): PermissionCheck {
  let roles: readonly string[];
  let options: { bypassRoles?: readonly string[]; includeOrgRoles?: boolean } | undefined;

  if (typeof rolesOrFirst === "string") {
    roles = [
      rolesOrFirst,
      ...(typeof optionsOrSecond === "string" ? [optionsOrSecond] : []),
      ...rest,
    ];
    options = undefined;
  } else {
    roles = rolesOrFirst;
    options = optionsOrSecond && typeof optionsOrSecond === "object" ? optionsOrSecond : undefined;
  }

  const includeOrgRoles = options?.includeOrgRoles ?? true;

  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return deny("Authentication required");
    }

    const userRoles = getUserRoles(ctx.user);

    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    if (roles.some((r) => userRoles.includes(r))) {
      return true;
    }

    if (includeOrgRoles) {
      const scope = scopeOf(ctx);
      if (isElevated(scope)) return true;
      if (isMember(scope) && roles.some((r) => scope.orgRoles.includes(r))) {
        return true;
      }
    }

    return deny(`Required roles: ${roles.join(", ")}`);
  };
  check._roles = roles;
  return check;
}

/**
 * Require a PLATFORM role — global roles only. An organization role can never
 * satisfy this gate.
 *
 * `requireRoles(["ops"])` also accepts an ORG role named `ops` (that is its
 * documented default), and `requireOrgRole("manager")` grants ANY organization's
 * manager. Both return a bare allow with no policy, so a surface that is global
 * by construction — a queue dashboard, a cluster-wide operations endpoint —
 * cannot distinguish them from a real operator gate by looking at the decision.
 * That makes "platform-only" a property the check has to DECLARE, which is what
 * `_platformOnly` records and what such a surface can then require.
 *
 * Elevated scope passes: platform admin is the identity this gate is for.
 *
 * @example
 * permissions: { list: requirePlatformRole("platform-ops") }
 */
export function requirePlatformRole(...args: string[] | [readonly string[]]): PermissionCheck {
  const roles = normalizeVariadicOrArray(args);

  const check: PermissionCheck = (ctx) => {
    // Deliberately reads `scopeOf(ctx)` for elevation and `ctx.user` for roles —
    // and NEVER `scope.orgRoles`. That omission is the whole contract.
    if (isElevated(scopeOf(ctx))) return true;
    if (!ctx.user) return deny("Authentication required");
    const userRoles = getUserRoles(ctx.user);
    if (roles.some((r) => userRoles.includes(r))) return true;
    return deny(`Required platform roles: ${roles.join(", ")}`);
  };
  check._roles = roles;
  check._platformOnly = true;
  return check;
}

/**
 * Short-form alias of `requireRoles()`. Identical behavior — checks both
 * platform roles AND org roles. Prefer `requireRoles` for new code; this
 * exists for call sites that want a terser name.
 */
export function roles(...args: string[] | [readonly string[]]): PermissionCheck {
  const roleList = normalizeVariadicOrArray(args);

  const check: PermissionCheck = (ctx) => {
    if (!ctx.user) {
      return deny("Authentication required");
    }

    const userRoles = getUserRoles(ctx.user);
    if (roleList.some((r) => userRoles.includes(r))) {
      return true;
    }

    const scope = scopeOf(ctx);
    if (isElevated(scope)) return true;
    if (isMember(scope) && roleList.some((r) => scope.orgRoles.includes(r))) {
      return true;
    }

    return deny(`Required roles: ${roleList.join(", ")}`);
  };
  check._roles = roleList;
  return check;
}

/**
 * Require resource ownership. Returns filters to scope queries to the
 * caller's owned resources.
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: requireOwnership('userId'),
 *   delete: requireOwnership('createdBy', { bypassRoles: ['admin'] }),
 * }
 * ```
 */
export function requireOwnership<TDoc = Record<string, unknown>>(
  ownerField: Extract<keyof TDoc, string> | string = "userId",
  options?: { bypassRoles?: readonly string[] },
): PermissionCheck<TDoc> {
  return (ctx) => {
    if (!ctx.user) {
      return deny("Authentication required");
    }

    const userRoles = getUserRoles(ctx.user);

    if (options?.bypassRoles?.some((r) => userRoles.includes(r))) {
      return true;
    }

    const userId = getScopeUserId(scopeOf(ctx)) ?? ctx.user.id ?? ctx.user._id;
    if (!userId) {
      return deny("User identity missing (no id or _id)");
    }
    // Grant + row-level data policy scoping queries to the caller's own records.
    return allow({ policy: { [ownerField]: userId } });
  };
}

/**
 * Combine multiple checks — ALL must pass (AND logic).
 *
 * Evaluation is PURE — nothing is written to the request. Each child runs
 * against the accumulated state of previous children, threaded through a fresh
 * child context:
 *   - `policy` from earlier children is CONJOINED (logical AND) — a later child
 *     can add or narrow restrictions but never silently replaces an earlier
 *     child's constraint on the same key (conflicting values are preserved under
 *     `$and`; see `conjoinPolicyFilters`)
 *   - `scope` installed by an earlier child is visible to the next through
 *     `scopeOf(ctx)`, and never downgrades an already-authoritative scope
 *
 * The returned decision carries the merged `policy` + `scope`; the enforcement
 * point (`applyAuthorizationDecision`) applies them to the request once.
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: allOf(requireAuth(), requireRoles(['editor']), requireOwnership('createdBy')),
 *   list: allOf(requireApiKey(), requireOrgMembership()),
 * }
 * ```
 */
export function allOf(...checks: PermissionCheck[]): PermissionCheck {
  const check: PermissionCheck = async (ctx) => {
    // PURE evaluation (arc 2.30): no request mutation, no rollback. Each branch's
    // scope/policy is threaded to the NEXT branch through a fresh child context,
    // so `allOf(requireApiKey(), requireServiceScope(...))` lets branch 2 read
    // branch 1's installed scope via `scopeOf(childCtx)` — without touching the
    // shared request. The composed decision carries the merged policy + scope;
    // the enforcement point (PEP) applies it once.
    let mergedFilters: Record<string, unknown> = {};
    let installedScope: RequestScope | undefined;
    // `threaded` = the scope visible to the current branch. Starts from the
    // incoming context; upgrades when a branch installs a stronger scope over an
    // absent/public one (the non-downgrade rule).
    let threaded = ctx.scope;
    let childCtx = ctx;

    for (const inner of checks) {
      const decision = normalizeToDecision(await inner(childCtx));

      if (decision.effect !== "allow") return deny(decision.reason);

      if (decision.policy) {
        // AND semantics: every branch's data policy is a restriction that must
        // hold. Conjoin (never overwrite) so an earlier branch's constraint on a
        // key is preserved when a later branch constrains the same key.
        mergedFilters = conjoinPolicyFilters(mergedFilters, decision.policy);
      }

      if (decision.scope && (!threaded || threaded.kind === "public")) {
        // Install a stronger scope over an absent/public one, and thread it to
        // subsequent branches. Never downgrade an already-authoritative scope.
        threaded = decision.scope;
        installedScope = decision.scope;
      } else if (decision.scope && !installedScope) {
        installedScope = decision.scope;
      }

      if (threaded !== childCtx.scope) childCtx = { ...childCtx, scope: threaded };
    }

    return allow({
      ...(Object.keys(mergedFilters).length > 0 ? { policy: mergedFilters } : {}),
      ...(installedScope ? { scope: installedScope } : {}),
    });
  };

  // Introspection meta — allOf grants only if ALL branches do (intersection).
  // Role introspection is well-defined only for the common single-role-branch
  // shape (e.g. allOf(requireFlowMode(...), requireRoles(...))) where the other
  // branches impose orthogonal constraints (flow-mode, ownership). With 0 or >1
  // role branches the role intersection is ambiguous, so we leave meta unset.
  const roleBranches = checks.filter(
    (c) => (c._roles?.length ?? 0) > 0 || (c._orgRoles?.length ?? 0) > 0,
  );
  // ANY denied branch closes the whole conjunction — nothing can satisfy every
  // branch when one admits nobody. Checked FIRST so a public or role-gated
  // sibling cannot describe the composite as reachable; `allOf(denyAll(),
  // allowPublic())` is a closed door, not a public one.
  if (checks.some((c) => c._isDenied)) {
    check._isDenied = true;
  } else if (checks.length > 0 && checks.every((c) => c._isPublic)) {
    check._isPublic = true;
    // AND: every branch's policy is conjoined, so ONE row-filtered branch
    // filters the whole conjunction.
    if (checks.some((c) => c._rowPolicy)) check._rowPolicy = true;
  } else if (roleBranches.length === 1) {
    const [rb] = roleBranches;
    if (rb?._roles?.length) check._roles = [...rb._roles];
    if (rb?._orgRoles?.length) check._orgRoles = [...rb._orgRoles];
  }

  // Scope-context is CONJUNCTIVE under allOf — every branch's required scope
  // dimensions must ALL hold, so merge them. This lets a composed HQ gate
  // `allOf(requireRoles('admin'), requireScopeContext('branchRole','head_office'))`
  // introspect as a `scoped` requirement carrying BOTH the roles (above) and the
  // branch-role dimension — "admin AND head-office", not just "admin".
  const scopeContext: Record<string, string | undefined> = {};
  let scopeConflict = false;
  for (const c of checks) {
    for (const [dim, val] of Object.entries(c._scopeContext ?? {})) {
      // A second branch demanding a DIFFERENT value for the same dimension is a
      // contradiction (e.g. branchRole hq AND sub) — unsatisfiable at runtime.
      // Flag it so the composite is never reported as a definitive allow.
      if (dim in scopeContext && scopeContext[dim] !== val) scopeConflict = true;
      else scopeContext[dim] = val;
    }
  }
  if (Object.keys(scopeContext).length > 0) check._scopeContext = scopeContext;

  // SOUNDNESS (necessary vs sufficient): the surfaced role/scope meta describes
  // only the branches that EXPOSE meta. If any OTHER branch constrains at runtime
  // without exposing role/scope meta — ownership, a custom predicate, a dynamic
  // matrix, flow-mode, quota — then holding the role / matching the scope is
  // NECESSARY but not SUFFICIENT: the opaque branch can still deny. Mark the
  // composite `conditional` so `explainAccess` never upgrades a partial match to a
  // definitive `allow`. `requireAuth()` alone is not "opaque" in this sense (it
  // adds no row-level condition beyond being signed in), so it doesn't taint.
  const hasMetaSurface = (c: PermissionCheck): boolean =>
    Boolean(
      c._isPublic ||
        c._roles?.length ||
        c._orgRoles?.length ||
        (c._scopeContext && Object.keys(c._scopeContext).length > 0),
    );
  const opaqueBranch = checks.some((c) => !hasMetaSurface(c) && !c._requiresAuth);
  // Also PROPAGATE a nested child's own conditionality: an already-conditional
  // child (e.g. `allOf(requireRoles(...), requireOwnership(...))`) exposes role
  // meta, so it isn't "opaque" above — but its surfaced roles are themselves
  // necessary-not-sufficient. Without this, `allOf(inner, requireAuth())` would
  // drop `inner`'s conditionality and `explainAccess` could report a false allow.
  const childConditional = checks.some((c) => c._conditional);
  if (opaqueBranch || scopeConflict || childConditional) check._conditional = true;

  return check;
}

/**
 * Combine multiple checks — ANY must pass (OR logic).
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: anyOf(requireRoles(['admin']), requireOwnership('createdBy')),
 * }
 * ```
 */
export function anyOf(...checks: PermissionCheck[]): PermissionCheck {
  const check: PermissionCheck = async (ctx) => {
    const reasons: string[] = [];

    for (const inner of checks) {
      const decision = normalizeToDecision(await inner(ctx));

      if (decision.effect === "allow") {
        // Preserve the granting branch's data policy + scope in the decision.
        return allow({
          ...(decision.policy ? { policy: decision.policy } : {}),
          ...(decision.scope ? { scope: decision.scope } : {}),
        });
      }

      if (decision.reason) {
        reasons.push(decision.reason);
      }
    }

    return deny(reasons.join("; "));
  };

  // Introspection meta (PermissionCheckMeta) — anyOf grants if ANY branch does,
  // so the allowed principals are the UNION of the branches'. Public if any
  // branch is public. Roles are emitted only when EVERY branch is role-gated: an
  // authenticated/custom branch broadens beyond any role list, so we leave meta
  // unset (introspects as "authenticated") rather than under-report access.
  // A disjunction is closed only when EVERY branch is — the mirror of `allOf`.
  // One `denyAll()` among granting branches contributes nothing and must not
  // describe the union as denied.
  if (checks.length > 0 && checks.every((c) => c._isDenied)) {
    check._isDenied = true;
  } else if (checks.some((c) => c._isPublic)) {
    check._isPublic = true;
    // What an ANONYMOUS caller gets is decided by the first public branch in
    // order (evaluation stops at the first grant, and a public branch grants
    // everyone). So the public surface is row-filtered exactly when that
    // branch is — a later unfiltered public branch is never reached.
    if (checks.find((c) => c._isPublic)?._rowPolicy) check._rowPolicy = true;
  } else if (checks.every((c) => (c._roles?.length ?? 0) > 0 || (c._orgRoles?.length ?? 0) > 0)) {
    const roles = new Set<string>();
    const orgRoles = new Set<string>();
    for (const c of checks) {
      for (const r of c._roles ?? []) roles.add(r);
      for (const r of c._orgRoles ?? []) orgRoles.add(r);
    }
    if (roles.size > 0) check._roles = [...roles];
    if (orgRoles.size > 0) check._orgRoles = [...orgRoles];
    // If ANY granting branch is itself conditional (e.g.
    // `anyOf(allOf(requireRoles('admin'), requireOwnership(...)), ...)`), then
    // holding a unioned role is NOT sufficient — that branch's opaque condition
    // still decides. Mark the whole disjunction conditional so `explainAccess`
    // can't report a false `allow`. Conservative by design: it also downgrades an
    // unconditional sibling branch to conditional (a single boolean can't say
    // "admin→allow, editor→conditional"); the precise fix is an expression AST.
    if (checks.some((c) => c._conditional)) check._conditional = true;
  } else if (
    checks.some(isMembershipGate) &&
    checks.every((c) => isMembershipGate(c) || isPlainRoleGate(c))
  ) {
    // "a member of the active org, OR one of these roles" — e.g. platform admin or branch staff.
    check._orgPermission = "membership";
    const roles = new Set<string>();
    const orgRoles = new Set<string>();
    for (const c of checks) {
      for (const r of c._roles ?? []) roles.add(r);
      for (const r of c._orgRoles ?? []) orgRoles.add(r);
    }
    if (roles.size > 0) check._roles = [...roles];
    if (orgRoles.size > 0) check._orgRoles = [...orgRoles];
  }

  return check;
}

const isMembershipGate = (c: PermissionCheck): boolean =>
  c._orgPermission === "membership" && !c._conditional && !c._scopeContext;

const isPlainRoleGate = (c: PermissionCheck): boolean =>
  ((c._roles?.length ?? 0) > 0 || (c._orgRoles?.length ?? 0) > 0) &&
  !c._conditional &&
  !c._scopeContext;

/**
 * Invert a permission check. Grants when the wrapped check denies, denies
 * when the wrapped check grants. Useful for "block if X" patterns —
 * e.g. `not(requireRoles(['guest']))` to deny guest access.
 *
 * NOTE: filters and scope from the wrapped check are intentionally
 * discarded — an inverted check has no row-level meaning.
 *
 * @example
 * ```typescript
 * permissions: {
 *   internalApi: not(requireRoles(['external'])),
 *   adminUI: allOf(requireAuth(), not(requireRoles(['readonly']))),
 * }
 * ```
 */
export function not(check: PermissionCheck, reason = "Access denied"): PermissionCheck {
  return async (ctx) => {
    const decision = normalizeToDecision(await check(ctx));
    return decision.effect === "allow" ? deny(reason) : true;
  };
}

/**
 * Deny all access.
 *
 * @example
 * ```typescript
 * permissions: { delete: denyAll('Deletion not allowed') }
 * ```
 */
export function denyAll(reason = "Access denied"): PermissionCheck {
  const check: PermissionCheck = () => deny(reason);
  /**
   * MARKED, not bare. Introspection (`describePermission`) reads metadata, and a
   * closure with none fell through to `{ kind: "authenticated" }` — publishing
   * the library's most restrictive gate as "any signed-in user may do this".
   * Enforcement was never wrong; the description was, in the direction that
   * makes a UI offer an action nobody can perform.
   */
  check._isDenied = true;
  return check;
}

/**
 * Dynamic permission based on a condition function.
 *
 * @example
 * ```typescript
 * permissions: {
 *   update: when((ctx) => ctx.data?.status === 'draft'),
 * }
 * ```
 */
export function when<TDoc = Record<string, unknown>>(
  condition: (ctx: PermissionContext<TDoc>) => boolean | Promise<boolean>,
): PermissionCheck<TDoc> {
  return async (ctx) => {
    const result = await condition(ctx);
    return result ? allow() : deny("Condition not met");
  };
}
