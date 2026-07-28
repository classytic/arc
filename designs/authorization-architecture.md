# Design: authorization architecture standardization (arc 2.31)

**Status**: PROPOSED (design for approval). Supersedes the ad-hoc permission
layer that grew across `core.ts` / `scope.ts` / `dynamic.ts` /
`applyPermissionResult.ts`. Builds on the 2.30 decision-only contract
(`AuthorizationDecision`, `allow()`/`deny()`, `PermissionResult` removed).

**One-line thesis**: make arc's authorization a textbook **PDP → PEP** system —
a *pure* decision core (Functional Core) and a *single* imperative enforcement
edge (Imperative Shell) — so the same `AuthorizationDecision` is calculated
transport-neutrally and enforced identically on REST, actions, aggregations,
MCP, jobs, and websockets. No per-surface drift, no request mutation during
evaluation, one canonical data-policy representation, one metadata source.

---

## Research grounding

| Source | What we take | What we reject |
|---|---|---|
| **AWS Cedar** (2023, Lean-verified) | Decisions are *pure data*; evaluation is *total* (never mutates, predictable on error); explicit `permit`/`forbid`; analyzability | External DSL + policy store (arc stays code-first, in-process) |
| **OpenID AuthZEN** (2024 draft PDP/PEP API) | Canonical decision shape: `{subject, action, resource, context} → decision`; a transport-neutral evaluation request | The over-the-wire JSON API (arc is in-process; we mirror the *shape*, not the transport) |
| **XACML** | PDP/PEP/PIP/PAP role separation; obligations as a *dispatched* concern | XML; shipping obligations before a dispatcher exists |
| **oso / SpiceDB list-filtering** | Policy → query filter ("data filtering"), compiled per store | A bespoke policy engine — repo-core Filter IR already is our AST |
| **Functional Core / Imperative Shell** (Bernhardt) | Pure evaluation, imperative shell applies effects — the fix for "combinators mutate the request" | — |

Convergent lesson: **decide purely, enforce once.** Arc's differentiator stays
what no single system above offers in-process: a typed decision that carries a
*portable data policy* (compiles to Mongo/SQL/any kit) enforced uniformly across
every transport.

---

## The decision (bottleneck test)

| Shape | Verdict |
|---|---|
| External policy DSL / engine (Cedar-lang, OPA/Rego) | REJECTED — out-of-process, untyped, second source of truth; arc is a code-first TS framework |
| Ship XACML-style obligations now | REJECTED — declared-but-unenforced contract (the 2.30 review's finding); design the *seam*, fill it only with a dispatcher + a real consumer |
| `definePermission` as a class hierarchy | REJECTED — arc's "functions, no classes" ethos; keep checks callable, store metadata immutably beside them |
| Keep `DataPolicy = Filter \| Record` union | REJECTED — the composer can't honor both; a union the runtime lies about |
| Mutate `request` during `allOf` evaluation | REJECTED — impure eval; blocks parallelism, `not(allOf(...))`, unit-testing without Fastify |
| **Pure PDP core + single PEP + canonical Filter-IR policy + transport-neutral context + immutable metadata** | **ACCEPTED** — below |

---

## Target architecture — five layers

```
transport (REST · action · aggregation · MCP · job · ws)
        │  each ADAPTS its raw request → PermissionContext (neutral facts)
        ▼
PermissionContext            ── transport-neutral facts (no FastifyRequest required)
        ▼
PermissionCheck (pure)       ── primitives: identity/roles/org/ownership/service/agent/grant
        ▼
decision algebra (pure)      ── allOf / anyOf / not / when — compose decisions, thread scope via context
        ▼
AuthorizationDecision        ── { effect, reason?, policy?: Filter, scope?, [obligations later] }
        ▼
enforcement engine (PEP)     ── ONE place: install scope · conjoin policy · (dispatch obligations) · shape denial
        ▼
repository / response        ── policy compiled per-kit; field redaction; audit
```

**Invariant (the whole point):** *Permission checks calculate decisions.
Enforcement points apply decisions. No permission check mutates the request.*

### Module map (single-responsibility, replaces the current sprawl)

```
permissions/
  decision.ts     AuthorizationDecision · allow · deny · normalizeToDecision · validateDecision
  policy.ts       DataPolicy (= repo-core Filter) · normalizePolicy(record|IR→IR) · andPolicy · matchesPolicy
  algebra.ts      allOf · anyOf · not · when · denyAll  (pure; no request access)
  context.ts      PermissionContext (neutral) · fromFastify / fromMcp / fromJob adapters
  metadata.ts     definePermission · PermissionMeta · composeMeta · immutable store (WeakMap)
  enforcement.ts  enforce(decision, sink) · evaluateAndEnforce — the ONE PEP
  explain.ts      explainAccess(resource, action, principal) · analyzers (public-surface, REST↔MCP parity)
  primitives/
    identity.ts   allowPublic · requireAuth
    roles.ts      requireRoles · roles
    organization.ts  requireOrgRole · requireOrgMembership · requireOrgInScope · requireScopeContext · requireTeamMembership
    ownership.ts  requireOwnership
    service.ts    requireServiceScope
    agent.ts      requireDPoP · requireMandate · requireAgentScope
    grants.ts     requireGrant · GRANT_MODES · modeSatisfies
    dynamic.ts    createOrgPermissions · createDynamicPermissionMatrix
  index.ts        barrel (unchanged public surface)
```

Net LOC is *lower* than today — this deletes the per-surface duplication
(`normalizePermissionGranted`, aggregation's private helpers, the request-mutation
+ rollback dance) and the record/IR duality.

---

## Contracts

### PermissionContext — transport-neutral (solves review #7)

```ts
interface PermissionContext<TDoc = Record<string, unknown>> {
  principal: Principal | null;         // normalized identity (id + roles), not raw user
  scope: RequestScope;                  // FIRST-CLASS — checks read ctx.scope, never getScope(request)
  resource: string;
  action: string;
  resourceId?: string;
  params?: Readonly<Record<string, string>>;
  data?: Partial<TDoc> | Record<string, unknown>;
  attributes?: Readonly<Record<string, unknown>>;  // headers/claims a check needs (ABAC)
  transport?: { kind: "http" | "mcp" | "job" | "ws"; raw?: unknown };  // escape hatch, never required
}
```

`request` moves to `transport.raw` (escape hatch). Checks read `ctx.scope` /
`ctx.attributes`. MCP stops building a `fakeRequest`; jobs/ws build a context
directly. **Back-compat:** a thin shim keeps `ctx.request` working for custom
checks during migration.

### AuthorizationDecision — canonical (2.30, unchanged surface)

```ts
interface AuthorizationDecision {
  effect: "allow" | "deny";
  reason?: string;
  policy?: DataPolicy;   // repo-core Filter IR (see below)
  scope?: RequestScope;
  // obligations?: Obligation[]  ── seam reserved; NOT shipped until a dispatcher exists
}
```

### DataPolicy = repo-core `Filter` IR — one representation (solves review #2/#3)

```ts
type DataPolicy = Filter;  // repo-core AST: eq/ne/in/and/or/not/… — one canonical shape
```

- `allow({ policy })` accepts a Mongo-style record **or** IR at the boundary and
  **normalizes immediately** to IR (`normalizePolicy` → `policyRecordToFilter`).
- Composition uses repo-core `and()` / `or()` — never `Object.assign`, never a
  `$and` Mongo-record hand-roll.
- `_policyFilters` on the request becomes IR; in-memory checks use repo-core
  `matchFilter`; DB uses the kit's IR compiler. **`toRepositoryFilter` and the
  record-dialect `conjoinPolicyFilters` retire** — the IR is the single seam.
- Analyzable: an AST can be explained/inspected; a Mongo record can't.

### PermissionMeta — immutable, one source (solves review #8)

```ts
const requireRoles = definePermission({
  metadata: { authentication: "required", platformRoles: [...] },
  evaluate: (ctx) => ctx.roles.some(...) ? allow() : deny(...),
});
```

Callable for ergonomics (`requireRoles('admin')`), metadata stored in a `WeakMap`
(no `_roles` mutable props). `composeMeta(children, "and"|"or")` gives combinators
one derivation rule instead of hand-written accumulation. Feeds `explainAccess`,
the permission matrix, and MCP tool descriptions from **one** place.

---

## How each layer resolves the open findings

- **#1 cross-surface enforcement** → every surface calls `evaluateAndEnforce`;
  `enforce()` is the only code that touches policy/scope. Aggregation parity
  (shipped in 2.30) becomes structural, not a patch. New surfaces (jobs, ws) get
  it for free.
- **#2/#3 policy representation** → one Filter-IR representation; composition via
  repo-core algebra; no union, no `Object.assign` on security filters.
- **#5 pure combinators** → `allOf` threads accumulated scope through a *new
  context* per child (`{...ctx, scope}`), never mutating the request; rollback
  code deleted; `not(allOf(...))` and parallel evaluation become sound.
- **#7 transport coupling** → neutral `PermissionContext`; adapters build it;
  raw request is an escape hatch.
- **#8 metadata** → `definePermission` + immutable store + `composeMeta`.

---

## Ahead-of-time seams (designed now, filled only on demand — no bloat)

1. **Obligation dispatch** — `enforce()` has a single ordered hook point where an
   obligation dispatcher *would* run. Ships EMPTY; adding audit/redact obligations
   later is registering a dispatcher, not a redesign.
2. **New transports** — `context.ts` adapters are the only thing a jobs/ws/gRPC
   surface adds; the PDP + PEP are transport-agnostic already.
3. **`explainAccess` / analyzers** — built on `PermissionMeta`; enables an
   `arc audit`-style report and REST↔MCP parity checks without touching the core.
4. **Policy IR analysis** — because `policy` is an AST, future static tools
   (contradiction detection, cost estimate) plug in without changing the contract.

---

## Migration phases (each: `tsc` 0 + full suite green before the next)

| Phase | Scope | Risk |
|---|---|---|
| **P0** | `PermissionContext` gains `scope`/`principal`/`attributes` first-class; adapters populate them; primitives read `ctx.scope`; `ctx.request` shim kept | Low — additive |
| **P1** | Pure `algebra.ts`: `allOf`/`anyOf` thread scope via context, delete request-mutation + rollback | Medium — combinator internals; covered by existing allOf tests |
| **P2** | `DataPolicy = Filter` canonical: `normalizePolicy` at `allow()`; composition via repo-core `and`; `_policyFilters`→IR; retire `toRepositoryFilter`/record-`conjoin` | Medium — touches QueryResolver + AccessControl + aggregation; conformance test guards it |
| **P3** | `enforcement.ts` PEP: `enforce`/`evaluateAndEnforce`; route CRUD/action/aggregation/MCP through it; empty obligation seam | Medium |
| **P4** | `metadata.ts` `definePermission` + `composeMeta`; migrate primitives; `explain.ts` | Medium |
| **P5** | Module reorg into `primitives/*`; `defineAuthorizationConformance({app, expectations})` reusable suite | Low — mechanical + tests |
| **P6** | Consumer migration (be-prod/spine), remove `ctx.request` shim = final break; publish | Coordinated |

Back-compat within arc during P0–P5: `ctx.request` shim + `allow()` accepting
record policy. The only breaking removal (shim) is P6, gated on publish.

---

## What we deliberately do NOT build (no-bloat guardrails)

- No external policy DSL/engine, no policy storage in core.
- No obligations until a dispatcher + a real consumer exist (seam only).
- No ReBAC/relationship graph in core (that's `requireGrant` + a host store).
- No class hierarchy for permissions — functions + immutable metadata.
- No new transport until a host needs it — adapters are ~20 lines each when it does.

---

## Conformance (the proof, reusable)

```ts
defineAuthorizationConformance({
  app,
  cases: [{ permission: requireOwnership("ownerId"), principal, resource: "doc" }],
  expect: { policyReachesRepo: true, restMcpParity: true, denyFailsClosed: true },
});
```

Runs the *same* permission through CRUD list/get/update, actions, aggregations,
and MCP tools, asserting policy + scope + denial identically. This is the
regression wall that keeps "partial enforcement" from ever returning.
