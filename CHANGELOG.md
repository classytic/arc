# Changelog

## 2.10 — migration notes (from 2.9.x)

**Tightened `ActionHandler` req type.** The third argument of action
handlers (`defineResource({ actions: { foo: (id, data, req) => ... } })`)
is now typed `RequestWithExtras` instead of the bare `FastifyRequest`.
`RequestWithExtras` adds the arc-populated `arc`, `context`,
`_policyFilters`, `fieldMask`, `_ownershipCheck` fields that every action
handler was reaching for via `as any` — now they're on the type.

- **Breaking for code that assigned the handler to a `FastifyRequest`-typed
  local** (several be-prod files broke here). Fix: let TS infer the param
  type, or import `RequestWithExtras` from `@classytic/arc` and use it
  explicitly.
- Non-breaking if you used `req: any` or inferred — the runtime object
  is unchanged.

**`EventsDecorator.subscribe` handler signature clarified.** Handlers
receive a `DomainEvent<T> = { type, payload, meta }` envelope — *not* a
bare payload. This has always been the runtime shape; the type now
reflects it:

```ts
// Before (runtime contract, loosely typed):
fastify.events.subscribe('order.created', async (event) => {
  // event was typed `unknown` — you had to cast
});

// After (explicit envelope type):
fastify.events.subscribe('order.created', async (event) => {
  event.type;             // 'order.created'
  event.payload;          // your typed payload
  event.meta.timestamp;   // Date
  event.meta.correlationId;
});
```

If you wrote handlers against the old `unknown` type and destructured
`payload` directly, nothing changes at runtime — only the type is now
narrower. If you wrote `(payload) => ...` assuming the argument was the
payload, switch to `(event) => event.payload`.

## 2.10.7 — finish the tenant auto-inject (adapter schema forwarding)

Supersedes 2.10.6 (unpublished). 2.10.6 shipped the tenant `systemManaged`
+ `preserveForElevated` auto-inject but wired it only half-way: the
rule landed on `resolvedConfig.schemaOptions` (which `BodySanitizer`
reads), but `defineResource` still forwarded the raw `config.schemaOptions`
to `adapter.generateSchemas()`. Result: runtime correctly stripped
`organizationId` from create bodies, but the generated OpenAPI / MCP
body schemas still advertised it as a writable input field. Every
multi-tenant host had to restate the boilerplate at the adapter layer
for their docs to match runtime behaviour.

### 1. Fix the forwarding (one-liner that makes the auto-inject real)

`defineResource` now passes `resolvedConfig.schemaOptions` to
`adapter.generateSchemas()` instead of the raw input. Adapters see the
injected `{ systemManaged: true, preserveForElevated: true }` rule, so
OpenAPI and MCP generators strip the tenant field from `createBody` /
`updateBody` without any host-side restatement.

### 2. Centralize the inject in a shared util (zero redundancy)

Extracted to `src/core/schemaOptions.ts`'s
`autoInjectTenantFieldRules(schemaOptions, tenantField)`. One function,
one caller, one source of truth. Future downstream consumers that need
"the effective post-resolve schemaOptions for a resource" can import
this instead of reinventing the merge — prevents the 2.10.6 bug class
from recurring when someone adds a new adapter entry point.

Extensive unit tests cover the helper in isolation
([tests/core/schemaOptions-util.test.ts](tests/core/schemaOptions-util.test.ts)):
no-op when `tenantField` is `false` / `undefined`, respects caller
opt-outs (`systemManaged: false`), preserves sibling rules, uses the
configured field name (not hard-coded to `organizationId`), never
mutates the input. Integration tests in
[tests/core/v2-10-7-schema-inject-regression.test.ts](tests/core/v2-10-7-schema-inject-regression.test.ts)
prove the end-to-end `defineResource → adapter.generateSchemas` flow
receives the injected rule.

### 3. Normalize all `config` reads after preset resolution

Audited `defineResource.ts` for every remaining `config.X` read that
happened after `resolvedConfig` was established. Normalized each to
`resolvedConfig.X` — `idField`, `name`, `adapter`, `queryParser`,
`openApiSchemas`, `module`. Presets don't mutate most of these today,
but using a single source of truth removes the "which copy wins"
ambiguity permanently.

**Consumer impact:** for multi-tenant hosts, you can now remove
`schemaOptions: { fieldRules: { organizationId: { systemManaged: true } } }`
from your `defineResource` call — arc's auto-inject now covers both
runtime (sanitizer) and docs (OpenAPI / MCP). Hosts who had that
boilerplate can delete it; hosts who didn't are no longer shipping
half-protected resources.

## 2.10.6 — tenant threading + action fallback + DX type fixes + dead-code cleanup (unpublished)

Supersedes 2.10.4 and 2.10.5 (both unpublished). Bundles every fix from
the in-flight 2.10.5 drafts plus a second round of host-reported fixes,
two reviewer-flagged regressions, and a cleanup that removed a 200-LOC
MongoDB-syntax fallback engine from `AccessControl`. All changes land in
one release so the published version line stays clean.

### Quick migration checklist

| If you… | Do this |
|---|---|
| Imported `requestContext` / `arcLog` / `guard` / `middleware` from `@classytic/arc` root | Move to `@classytic/arc/{context,logger,pipeline,middleware}` subpaths. |
| Relied on `rateLimit: { max: 1000, timeWindow: "1 minute" }` in the `development` preset | The dev preset is now `rateLimit: false` (matches `testing` / `edge`). See "dev-preset rate limit" below. |
| Used `fastify.arc.xxx` without a null check | Add `?.` or `if (fastify.arc)` — the declaration is now `arc?: ArcCore`. |
| Hit a `ControllerLike` cast (`as unknown as ControllerLike`) | Remove the cast — the index signature is gone. |
| Register `ErrorMapper` with `as unknown as ErrorMapper` | Use `defineErrorMapper<T>(...)` from `@classytic/arc/utils`. |
| Shipped a resource with shorthand action `{ send: async (...) => ... }` and no permission | Either declare `actions.send.permissions: …`, `actionPermissions: …`, or `permissions.update: …` — shorthand actions now throw at boot if no gate can be inherited. |
| Consume `BaseController.list`'s return type as `OffsetPaginationResult<T>` | Broaden to the `ListResult<T>` union or narrow with `Array.isArray(data)` / `'nextCursor' in data`. |
| Wrote custom repo adapters with a handwritten Mongo-style `matchesFilter` | Keep your adapter matcher — arc still delegates to it. Otherwise arc now falls back to a tiny flat-equality matcher (covers `{ownerId:…}`, `{organizationId:…}` etc.). Operator filters (`$in`, `$ne`) without an adapter matcher fail-closed. |

### 1. `BaseController` threads tenant into every repo call (plugin-scope fix)

**What was broken:** a repo wired with `@classytic/mongokit`'s
`multiTenantPlugin({ required: true })` threw `Missing 'organizationId' in
context for '<op>'` on every CRUD call, because arc only stamped the
tenant into the request body — not into the top-level repository
operation context the plugin reads from. Packages that knew about this
worked around it with a hand-rolled `skipWhen` checking `data[tenantField]`;
packages that didn't (e.g. `@classytic/pricelist`) broke at runtime.

**What changed:** `BaseController` now derives the tenant once per
request (`tenantRepoOptions(req)`) from `arcContext._scope` and the
`multiTenantPreset`-resolved fields, then spreads it at the TOP of every
repo call — `create`, `update`, `delete`, `getAll` (list), and merged
into `QueryOptions` for the access-controlled read path
(`accessControl.fetchDetailed` → `getById` / `getOne`). The diagnostic
`getOne(idOnly)` fallback in `AccessControl` also forwards the options
now, so the "is this cross-tenant or genuinely missing" probe runs under
the caller's scope instead of unscoped. Multi-field tenancy via
`multiTenantPreset({ tenantFields: [...] })` flows through too — the
preset stashes resolved fields on `request._tenantFields`, which
`tenantRepoOptions` merges alongside the single-field scope value.

**Why this matters:** host apps can now drop a `multiTenantPlugin` onto
their repo without custom `skipWhen` logic — `required: true` works
straight through arc's CRUD pipeline. Validated against both kits with
seeded data:

- [tests/integration/mongokit-multi-tenant.test.ts](tests/integration/mongokit-multi-tenant.test.ts)
  — 9 scenarios against `@classytic/mongokit`'s `multiTenantPlugin({ required: true })`.
- [tests/integration/sqlitekit-multi-tenant.test.ts](tests/integration/sqlitekit-multi-tenant.test.ts)
  — 8 scenarios against `@classytic/sqlitekit`'s `multiTenantPlugin({ requireOnWrite: true, resolveTenantId })`.

Both kits expose different plugin surfaces (`contextKey: 'organizationId'`
vs `resolveTenantId(ctx)`) but arc's top-of-context stamping satisfies
each without kit-specific code.

Peer dep bumps: `@classytic/mongokit` is now `>=3.10.3` (was `>=3.10.2`)
to pick up 3.10.3's `allowDataInjection` option. `@classytic/sqlitekit`
is included as a test-time dev dep at `>=0.1.1`. Arc's fix interoperates
with both without kit-specific code.

### 2. Shorthand-action permission fallback (security)

**What was broken:** the function-shorthand action form —
`actions: { send: async (id, data, req) => ... }` — registered a handler
with no permission gate. When the resource also had no top-level
`actionPermissions`, the action fell through to "authenticated-only":
any logged-in user could invoke it, regardless of role. This was a
silent authz hole: the shorthand looked identical to the object form
that ships with an explicit `permissions: requireRoles([...])`, but
skipped authorization entirely.

**What changed:** the normalizer now applies a fallback chain when an
action has no explicit gate:

1. `ActionDefinition.permissions` — per-action check.
2. Resource-level `actionPermissions` — global gate for all actions.
3. **Resource-level `permissions.update`** — sensible default: actions
   mutate state, so inheriting the update gate is safer than auth-only.
4. **Boot-time throw** — if none of the above are set, `defineResource`
   refuses to register. The message explains how to fix it (declare one
   of the three, or use `allowPublic()` if public is truly intended).

When the update-fallback kicks in (step 3), the arc logger emits a
structured warning so upgrading apps can migrate to explicit perms
without being silently rescued forever.

**Migration:** apps running shorthand actions against resources with
`permissions.update` set are safe — the new fallback promotes them from
auth-only to admin-gated (or whatever the update gate is) and logs once.
Apps with shorthand actions and no update gate will throw at boot and
need to declare a permission explicitly. Public actions must opt in via
`allowPublic()` — accidental auth-only is no longer possible.

Tests live in [tests/core/routes-and-actions.test.ts](tests/core/routes-and-actions.test.ts)
under `"v2.10.5: action permission fallback chain (security)"`.

### 3. `ErrorMapper<T>` accepts abstract classes and specific ctor signatures

**What was broken:** `ErrorMapper<T>['type']` was typed
`new (...args: unknown[]) => T`. Abstract base errors (like
`@classytic/flow`'s `FlowError`) and concrete classes with specific
signatures (like `new InvalidTransitionError(from, to, id?)`) couldn't
be assigned without consumers casting through `as never` / `as any`.

**What changed:** widened to `abstract new (...args: any[]) => T`. The
`instanceof` check at runtime is what actually drives dispatch — the
ctor signature is just for type binding, and a permissive one lets
real-world error classes register without gymnastics.

### 4. `FastifyInstance.arc` is optional — no more collision with host augmentations

**What was broken:** `arcCorePlugin.ts` augmented `FastifyInstance` with
a non-optional `arc: ArcCore`. Any consumer of any `@classytic/arc/*`
subpath got this merged into every `FastifyInstance` — including apps
that never register `arcCorePlugin`. Worse, hosts trying to narrow with
`interface X extends FastifyInstance { arc?: MyArc }` collided because
`arc?: MyArc` isn't assignable to the parent's `arc: ArcCore`.

**What changed:** the declaration is now `arc?: ArcCore`. Apps that
register `arcCorePlugin` treat it as present at runtime (its internal
call sites narrow explicitly — see
[src/factory/registerAuth.ts](src/factory/registerAuth.ts),
[src/factory/createApp.ts](src/factory/createApp.ts)). Apps that don't
register it now get a correct "possibly undefined" type instead of a
silent lie.

**Migration for consumers who read `fastify.arc` directly:** prefer
`fastify.arc?.registry.getAll()` or narrow via
`if (fastify.arc) { ... }`. A non-null assertion (`fastify.arc!`) is
fine inside code that runs *after* `createApp`.

### 5. Expose `middleware` / `pipeline` / `context` / `logger` subpaths

Four barrel modules had source, tests, and `index.ts` barrels but no
`package.json` export entry and no `tsdown` build entry — so consumers
could only reach them through the root barrel, which either re-exported
a subset (leaking the rest) or didn't re-export them at all. Surfaced by
the fajr-be-arc team when `@classytic/arc/middleware` 404'd on import —
the only way to get `multipartBody` was to inline a ~160-line copy of
[src/middleware/multipartBody.ts](src/middleware/multipartBody.ts) into
the app, with no way to pick up upstream fixes.

| Subpath | Symbols newly reachable |
|---|---|
| `@classytic/arc/middleware` | `multipartBody`, `ParsedFile`, `MultipartBodyOptions` (were unreachable from any public path), plus `middleware`, `sortMiddlewares`, `NamedMiddleware` |
| `@classytic/arc/pipeline` | `executePipeline`, `NextFunction`, `OperationFilter` (were unreachable — `NextFunction` is the parameter type for `intercept` handlers, so anyone writing interceptors hit TS2724), plus `guard`, `intercept`, `pipe`, `transform`, `Guard`, `Interceptor`, `PipelineConfig`, `PipelineContext`, `PipelineStep`, `Transform` |
| `@classytic/arc/context` | `requestContext`, `RequestStore` |
| `@classytic/arc/logger` | `arcLog`, `configureArcLogger`, `ArcLogger`, `ArcLoggerOptions`, `ArcLogWriter` |

**Root re-exports removed** for the same four modules. The root barrel's
own doc comment already stated "this main entry exports ONLY the
essentials — all other features live in dedicated subpaths — Node.js does
NOT tree-shake, so barrel re-exports load eagerly at runtime," but
`requestContext`, `middleware`/`sortMiddlewares`/`NamedMiddleware`,
`guard`/`intercept`/`pipe`/`transform` (+ pipeline types), and
`arcLog`/`configureArcLogger` (+ logger types) were still re-exported
from root and pulled their transitive graphs into every consumer that
imported anything from `@classytic/arc`. Removing them brings root in
line with the documented policy.

**Consumer migration** — mechanical search-and-replace:

```ts
// Before
import { requestContext, arcLog, guard, intercept, middleware } from '@classytic/arc';

// After
import { requestContext } from '@classytic/arc/context';
import { arcLog } from '@classytic/arc/logger';
import { guard, intercept } from '@classytic/arc/pipeline';
import { middleware } from '@classytic/arc/middleware';
```

Regression guards: [tests/smoke/exports.test.ts](tests/smoke/exports.test.ts)
asserts that the four new subpaths resolve and that each one's headline
symbols (`multipartBody`, `executePipeline`, `requestContext.run`,
`arcLog`) are reachable. [tests/core/public-api-contract.test.ts](tests/core/public-api-contract.test.ts)
pins the exact set of `package.json` export keys plus runtime-symbol
assertions for the new subpaths. A future accidental drop fails
`npm run test:ci`.

### 6. Auto-mark `tenantField` as `systemManaged` + `preserveForElevated`

**What was broken:** every multi-tenant resource had to restate the
boilerplate `schemaOptions.fieldRules: { organizationId: { systemManaged: true } }`
to prevent member clients from forging
`POST /invoices { organizationId: 'victim-org' }`. Forget to set it
and the client's value wins until arc's `BaseController.create` stamps
it from scope — fine for member callers, but broken for elevated-admin
cross-tenant creates where scope has no pinned org.

**What changed:** `defineResource` auto-injects both
`systemManaged: true` AND a new `preserveForElevated: true` rule on the
configured `tenantField`. `BodySanitizer` honors `preserveForElevated`
so elevated admins without a pinned org can still stamp the target org
via the request body (the only channel available to them). Member and
service callers continue to have the field stripped, and
`BaseController.create` re-stamps from scope whenever one exists.
Tests in [tests/core/v2-10-6-fixes.test.ts](tests/core/v2-10-6-fixes.test.ts)
cover the four code paths — member strip, member re-stamp, elevated
preserve, elevated pinned re-stamp.

Hosts who explicitly declared `fieldRules: { organizationId: {...} }`
take precedence — arc only fills in when the rule is missing.

### 7. New `FieldRule.preserveForElevated` flag

**What's new:** `RouteSchemaOptions.fieldRules[field].preserveForElevated?: boolean`
opts a field out of `BodySanitizer`'s systemManaged / readonly /
immutable strip when the caller's scope is elevated. Used by the
auto-injection above, and available for hosts that want
elevation-only body overrides on other fields (e.g. `createdBy` from
an admin impersonation flow).

### 8. First-class `req.scope` projection on `IRequestContext`

**What was broken:** controller overrides that needed tenant/user info
dug through `req.metadata._scope` and called `getOrgId` / `getUserId`
manually. Cross-cutting code (e.g. building a Flow / Order engine
context from an Arc handler) kept re-implementing the same getter.

**What changed:** `IRequestContext.scope` is now a first-class
`{ organizationId?, userId?, orgRoles? }` projection, populated by
`fastifyAdapter.createRequestContext`. Full scope shape (discriminated
union of `member` / `service` / `elevated` / `public`) still lives at
`req.metadata._scope` for code that branches on `scope.kind`; the
projection just surfaces the three keys every tenant-scoped override
reaches for.

```ts
async create(req: IRequestContext) {
  const flowCtx = {
    organizationId: req.scope?.organizationId,
    actorId: req.scope?.userId,
    actorRoles: req.scope?.orgRoles,
  };
  // … hand off to @classytic/flow
}
```

### 9. `ControllerLike` dropped its `[key: string]: unknown` index signature

**What was broken:** class instances with private fields or extra
domain methods (`#redactionRules`, `redact(...)`, etc.) didn't
structurally assign to `ControllerLike` because classes don't carry an
index signature. Every custom controller assignment needed
`as unknown as ControllerLike`.

**What changed:** index signature removed. The five optional CRUD slots
(`list`, `get`, `create`, `update`, `delete`) are what arc actually
invokes at runtime; extra methods on the class don't need to be part
of the contract. Real class instances assign without a cast now.

### 10. `defineErrorMapper<T>(...)` helper

**What was broken:** even after widening `ErrorMapper<T>['type']` to
`abstract new (...args: any[]) => T` (see section 3), the
`toResponse(err: T)` callback is still contravariant. Putting
`ErrorMapper<FlowError>` into an `ErrorMapper[]` (which defaults to
`ErrorMapper<Error>`) failed to type-check, and hosts ended up with
`as unknown as ErrorMapper` at every registration site.

**What changed:** new helper `defineErrorMapper<T>(mapper)` exported
from `@classytic/arc/utils`. Wraps the cast once, inside arc, with a
documented runtime invariant (dispatch is `instanceof`-driven, so
`toResponse` is never called with a non-`T` error). Registration sites
become:

```ts
import { defineErrorMapper } from '@classytic/arc/utils';

errorMappers: [
  defineErrorMapper<FlowError>({
    type: FlowError,
    toResponse: (err) => ({ status: 400, code: err.domainCode, message: err.message }),
  }),
];
```

### 11. Shorthand-action permission fallback — fail-closed

**What was broken:** `actions: { send: async (id, data, req) => ... }`
shorthand fell through to "authenticated-only" when the resource had
no `actionPermissions` global. Silent authz hole — any logged-in user
could invoke mutating actions regardless of role.

**What changed:** `normalizeActionsToRouterConfig` applies a fail-closed
fallback chain:
1. Per-action `permissions` (explicit per-action gate)
2. Resource-level `actionPermissions` (global for all actions)
3. Resource-level `permissions.update` (sensible default — actions mutate state)
4. Boot-time throw if none of the above are declared

When step 3 fires, arc logs one warning so upgrading hosts can migrate
to explicit gates. Step 4 forces authors to declare `allowPublic()`
when they genuinely want a public action — accidental auth-only is no
longer reachable. Tests in [tests/core/routes-and-actions.test.ts](tests/core/routes-and-actions.test.ts)
cover all three fallback paths plus the boot-time throw.

### 12. AccessControl: removed the 200-LOC Mongo fallback matcher

**What was broken:** `AccessControl.checkPolicyFilters` shipped a full
MongoDB-syntax evaluator (`$eq` / `$ne` / `$gt` / `$in` / `$regex` /
`$and` / `$or` / dot-paths, with ReDoS + prototype-pollution guards).
It was **dead code for mongokit users** — the primary fetch path uses
`getOne(compoundFilter)` which evaluates the filter at the DB layer,
so the in-memory matcher never fired. And it was **silently wrong for
non-Mongo adapters** — applying Mongo syntax against a row shaped by
SQL / Prisma / REST would misclassify quietly.

**What changed:** 200+ LOC removed from `AccessControl`. The class now
delegates policy-filter evaluation to the adapter's
`DataAdapter.matchesFilter` when supplied. For adapters that don't
supply one, arc falls back to a new `simpleEqualityMatcher` helper
(from `@classytic/arc/utils`) — a ~20-LOC flat-key equality evaluator
that covers 95% of real policy filters (ownership, tenant), rejects
operator-shaped values (fail-closed), and doesn't pretend to be Mongo.

Hosts that previously relied on the Mongo engine for operators need to
either (a) use mongokit, whose compound-filter path evaluates
operators at the DB layer — nothing to do; or (b) wire a richer
`matchesFilter` on their adapter. A one-shot log warn fires when arc
encounters operator-shaped filters without an adapter matcher so the
gap is visible.

Cleanups also landed: dead elevation branch in `checkOrgScope` removed,
Mongo-first docstring added to the module header, `ReDoS protection`
and `prototype pollution prevention` test suites removed (they tested
the removed engine; the guards are now the adapter's / DB's
responsibility — mongokit/sqlitekit/Prisma have their own engine-level
protections).

### 13. `ListResult<TDoc>` aligns with repo-core's `getAll` contract

**What was broken:** `repo-core`'s
`MinimalRepo.getAll()` explicitly permits three return shapes — offset
envelope, keyset envelope, or raw array. Arc narrowed to
`OffsetPaginationResult<TDoc>` and its internal comment called bare
arrays "non-conforming" — directly contradicting the published
contract. Consumers returning keyset shapes or bare arrays hit a
type mismatch.

**What changed:** new `ListResult<TDoc> = OffsetPaginationResult<TDoc>
| KeysetPaginationResult<TDoc> | TDoc[]` union. `BaseController.list`,
`BaseController.executeListQuery`, and `IController.list` all return
it. Arc passes the kit's response through verbatim; consumers narrow
on shape (`Array.isArray(data)`, presence of `total` → offset,
presence of `nextCursor` → keyset). Regression tests in
[tests/core/v2-10-6-review-fixes.test.ts](tests/core/v2-10-6-review-fixes.test.ts)
cover all three shapes.

### 14. Regression guards — plugin-scoped repo method binding + cross-tenant create

Two reviewer-flagged regressions shipped with 2.10.5 drafts were
caught and fixed before publication:

- **Plugin-scoped `getOne` lost `this` binding.** `AccessControl.fetchDetailed`
  extracted `repository.getOne` without binding → mongokit / sqlitekit /
  any repo-core descendant threw
  `Cannot read properties of undefined (reading '_buildContext')` on
  cross-tenant reads. Fixed by binding the method before invoke.
- **Elevated cross-tenant create stripped the body tenant.** Auto-marking
  `tenantField` as `systemManaged` (see section 6) broke the
  elevated-without-org write path — `BodySanitizer` stripped the
  body tenant, and `BaseController.create` had nothing to re-stamp from.
  Fixed by pairing with the new `preserveForElevated: true` flag (see
  section 7), which exempts elevated scopes from the strip for
  explicitly-marked fields.

Regression tests in [tests/core/v2-10-6-regressions.test.ts](tests/core/v2-10-6-regressions.test.ts)
lock both fixes in with real mongodb-memory-server scenarios.

### Dev preset — `rateLimit: false` (behavior change)

The `development` preset's rate limit is now **disabled** (`rateLimit: false`)
to match the `testing` and `edge` presets. Dev servers commonly get
rapid-fire requests from HMR reloads, test runners, and auth heartbeat
endpoints (Better Auth's `get-session`) — all sharing the same IP
bucket — and tripping the previous `{ max: 1000, timeWindow: "1 minute" }`
limit produced spurious 429s that looked like real bugs.

**Migration for workflows that relied on seeing 429s locally:**

```ts
// Option A — opt into a concrete limit explicitly
await createApp({
  preset: 'development',
  rateLimit: { max: 100, timeWindow: '1 minute' },
});

// Option B — use the testing preset (also rateLimit: false) if you
// were using development only for its defaults
await createApp({ preset: 'testing' });
```

Production continues to require an explicit `rateLimit` — the
`production` preset doesn't assume one.

### Deferred

Two issues were raised alongside these fixes but shipped no demand
evidence in audited host apps and were intentionally left for a later
release:

- **Generic adapter factory** (`createGenericAdapter({ list, get, create, update, delete })`) for non-mongokit engines
  — host apps (be-prod, fajr) wrap every third-party engine (`@classytic/flow`, `@classytic/order`, `@classytic/promo`, `@classytic/loyalty`) through `createAdapter` with a mongokit-compatible repo already. Zero demand signal. Revisit when a host tries to expose a genuinely non-mongokit backend (REST proxy, in-memory, SQL adapter) through arc's auto-CRUD.
- **Per-route `rateLimit` override** inside `RouteDefinition` — audited hosts solve per-route variation by splitting resources (`guest-order` vs `order`, `payment-webhook` vs `payment`) and applying resource-level `rateLimit` to each. Zero TODO comments, zero Fastify-passthrough workarounds. Revisit if a host reports genuine single-resource/multi-limit friction.

## 2.10.3 — plugin onSend race closures + idempotency lock-leak fix

Follow-up sweep to 2.9.3's `caching.ts` → `preSerialization` migration.
2.9.2 introduced `isReplyCommitted()` guards across five plugins as a
defensive patch for an async-onSend race with Fastify's
`onSendEnd → safeWriteHead` flush path. The guard silenced unhandled
rejections but didn't close the race window. 2.9.3 fixed `caching.ts`.
2.10.3 finishes the sweep for the remaining four:

| Plugin | Before | After | Why |
|---|---|---|---|
| [`requestId`](src/plugins/requestId.ts) | `onSend` | **`onRequest`** | Static header, known on arrival — fires for every response including 204/streams |
| [`versioning`](src/plugins/versioning.ts) | `onSend` | **`onRequest`** (merged with existing hook) | Static header derived from request; saves one async hook per request |
| [`response-cache`](src/plugins/response-cache.ts) | `onSend` | **`preSerialization`** | Needs payload — mirrors `caching.ts`'s 2.9.3 pattern |
| [`idempotency`](src/idempotency/idempotencyPlugin.ts) | `onSend` | **`preSerialization` + `onResponse`** | Split hook — body caching stays in preSerialization; lock release moves to onResponse (fires for EVERY response path) |

**Observed impact (be-prod, 3–4s Atlas latency from Bangladesh):**
slow `GET` responses no longer produce `ERR_HTTP_HEADERS_SENT` unhandled
rejections that triggered `process.on('unhandledRejection')` →
graceful-shutdown cascades. Full `be-prod` vitest suite: 75/75 pass,
0 unhandled rejections (was 13).

### Idempotency lock-leak on empty-body responses

Fastify skips `preSerialization` when the payload is `null` / `undefined`
— so a naive onSend → preSerialization move would have introduced a new
bug: 204 responses, `reply.code(200).send()` with no argument, and any
empty non-2xx reply would never unlock the idempotency key, holding the
lock until `ttlMs` expired and blocking legitimate retries.

**Fix — split responsibilities across two hooks:**

- `preSerialization` handles only body caching (correctly skipped for
  empty responses — nothing to cache)
- `onResponse` handles unlock for every response path (success, empty
  2xx, 4xx, 5xx, errors). Fires after flush, so no header race possible.
- `X-Idempotency-Key` response header moved to the idempotency middleware
  itself (earliest point the key is guaranteed-known and route-applicable),
  so it survives empty-body replies where the hook is skipped.
- The former `onError` hook is removed — subsumed by the universal
  `onResponse` unlock.

Regression tests added to [`tests/idempotency/plugin-integration.test.ts`](tests/idempotency/plugin-integration.test.ts)
for 204, empty-200, and empty-404 paths.

### Contributor invariant (new CLAUDE.md gotcha #15)

Arc plugins set response headers at `onRequest` (if the value is derivable
from the request) or `preSerialization` (if payload-dependent). `onSend`
is reserved for diagnostic tracing and final byte-level transforms — never
for header mutation.

`isReplyCommitted()` still ships at [src/utils/reply-guards.ts](src/utils/reply-guards.ts)
for third-party plugin authors; arc's own plugins no longer import it.

## 2.10.2 — fix: silent pagination in audit/outbox adapters

**Critical bug fix — 2.10.0 and 2.10.1 are deprecated on npm.**
**2.10.2 is unpublished** — use 2.10.3 which contains this fix plus the
plugin race closures.

Arc's `repositoryAsAuditStore.query()`, `repositoryAsOutboxStore.getPending()`,
`repositoryAsOutboxStore.getDeadLettered()`, and the purge batch loop all
called `repository.findAll(filter, { skip?, limit })`. mongokit's `findAll`
signature is `findAll(filter, OperationOptions)` — `OperationOptions` has
no `skip` or `limit` fields, so those were silently dropped. Consequence:

- `audit.query({ limit: 10 })` returned **every audit row** in the table
- `outbox.getPending(10)` returned every pending event
- `outbox.getDeadLettered(5)` returned every DLQ entry
- `outbox.purge()` fetched every delivered doc per batch iteration (memory
  blow-up on large outboxes)

**Fix** — switched the four call sites to `repository.getAll(params)`, which
takes `{ filters, sort, page, limit, select }` and returns the offset
pagination envelope `{ docs, ... }`. The adapter unwraps `.docs` and
handles both array + envelope returns for kit flexibility.

**AuditQueryOptions.offset → page conversion** — `AuditStore.query` exposes
offset-based pagination, mongokit exposes page-based. The adapter now
converts `page = Math.floor(offset / limit) + 1`. Callers using the
standard `offset = (page - 1) * limit` pattern get exact results;
unaligned offsets round down to the nearest page boundary (rare case,
documented).

**`missing`-methods check updated** — the outbox adapter now requires
`getAll` (on repo-core's `MinimalRepo` floor, guaranteed to be present)
instead of the optional `findAll`.

**Regression tests added** in
[`tests/integration/strict-false-plugins.test.ts`](tests/integration/strict-false-plugins.test.ts):

- `audit.query()` respects limit/offset with 25-row seed
- `outbox.getPending(5)` bounds to 5 of 15
- `outbox.getDeadLettered(3)` bounds to 3 of 8

## 2.10.1 — additive: expose repo→store adapters + mongokit ≥3.10.2

**Additive (no breaking changes):**

- `repositoryAsOutboxStore` — now re-exported from `@classytic/arc/events`
- `repositoryAsAuditStore` — now re-exported from `@classytic/arc/audit`
- `repositoryAsIdempotencyStore` — now re-exported from `@classytic/arc/idempotency`

The functions were already tested and stable but gated by the `exports`
field. Use them when you need to compose stores before registration:

- **Audit fan-out** — one entry in `auditPlugin({ customStores: [...] })`
  wired to your repo, other entries to Kafka/S3/Loki
- **Decorated outbox/idempotency** — wrap the repo-backed store with
  metrics, tracing, or key-namespacing before passing as `store:` /
  `repository:`

Passing `{ repository }` to the plugin remains the one-liner path for the
common case — nothing changes there.

**Dependency bump:**

- `peerDependencies["@classytic/mongokit"]` bumped `>=3.10.0` → `>=3.10.2`
- `devDependencies["@classytic/mongokit"]` bumped `^3.10.0` → `^3.10.2`
- CLI `arc init` scaffolds `@classytic/mongokit@^3.10.2`

## 2.10 — clean-break on repo-core types + outbox fix

### Breaking changes — repo-core is no longer re-exported

Arc 2.10 stops re-exporting types from `@classytic/repo-core`. The repo
contract has a single canonical home (repo-core); arc only defines types
it owns.

**Removed from the `@classytic/arc` public surface:**

| Removed name (arc 2.9) | Replacement |
|---|---|
| `CrudRepository<T>` | `StandardRepo<T>` from `@classytic/repo-core/repository` |
| `PaginatedResult<T>` | `OffsetPaginationResult<T>` from `@classytic/repo-core/pagination` |
| `KeysetPaginatedResult<T>` | `KeysetPaginationResult<T>` (same package) |
| `OffsetPaginatedResult<T>` | `OffsetPaginationResult<T>` |
| `WriteOptions`, `QueryOptions`, `FindOneAndUpdateOptions` | import from `@classytic/repo-core/repository` |
| `UpdateManyResult`, `DeleteResult`, `DeleteManyResult`, `DeleteOptions` | same |
| `RepositorySession`, `PaginationParams`, `InferDoc` | same |
| `BulkWriteOperation`, `BulkWriteResult` | same |

**Migration** — codemod your imports:

```ts
// Before
import type { CrudRepository, PaginatedResult, WriteOptions } from '@classytic/arc';

// After
import type { StandardRepo, WriteOptions } from '@classytic/repo-core/repository';
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
```

**Still exported from `@classytic/arc`** (arc-owned, not in repo-core):

- `RepositoryLike<T>` = `MinimalRepo<T> & Partial<StandardRepo<T>>` — arc's
  "floor + optionals" composition, used everywhere arc feature-detects kit
  capabilities at runtime.
- `PaginationResult<T>` — discriminated union of the offset/keyset shapes,
  used by `BaseController.list` and `getDeleted` where either is valid.

### Bugfix: outbox `fail()` on mongokit

- **Fix: `repositoryAsOutboxStore.fail()` now passes `updatePipeline: true`
  to `findOneAndUpdate`.** mongokit ≥3.8 blocks array-form (aggregation)
  updates by default as a safety rail; arc's outbox uses the pipeline
  form so `$ifNull` can preserve `firstFailedAt` across retries without a
  round-trip read. Without the flag, every `fail()` call — retry or DLQ
  transition — threw `"Update pipelines (array updates) are disabled"`.
  Caught by [`tests/integration/strict-false-plugins.test.ts`](tests/integration/strict-false-plugins.test.ts).

- **Docs: `audit`, `events`, `idempotency` production-ops pages now
  document the required mongokit plugins** (`methodRegistryPlugin` +
  `batchOperationsPlugin`) and the rationale for the `strict: false`
  passthrough schema. Previously users hitting "repository is missing
  required methods: deleteMany" had to read the adapter source to
  diagnose.

## 2.9.3

- **Fix: `cachingPlugin` `ERR_HTTP_HEADERS_SENT` under `light-my-request`.**
  Moved header mutation from `onSend` → `preSerialization`. The onSend
  hook ran after Fastify's chain had already scheduled `safeWriteHead`;
  under the vitest test harness (`app.inject()`) the async microtask
  yield let the response commit between our hook and `onSendEnd`,
  re-throwing "Cannot write headers after they are sent". preSerialization
  runs before the flush window, so no race. (2.9.2 attempted an
  `isReplyCommitted` guard — same reporter confirmed it didn't fix the
  actual bug; reverted.) 304 responses now use `reply.serializer()` to
  bypass JSON's `'""'` encoding for the empty body. ETag hashing now
  uses `JSON.stringify(payload)` instead of `String(payload)` — fixes a
  prior bug where every object response hashed to the same
  `"[object Object]"` tag.
- **Fix: auditPlugin retention (unbounded disk growth).** Added
  `retention: { maxAgeMs, purgeIntervalMs? }` option. The plugin
  registers an unref'd `setInterval` that calls `audit.purge(cutoff)`
  and cleans up in `onClose`. `AuditStore` gains
  `purgeOlderThan?(cutoff)` — optional, so append-only stores (Kafka,
  S3) are skipped silently. Repository adapter maps to
  `repository.deleteMany({ timestamp: { $lt: cutoff } })`.
  `fastify.audit.purge(cutoff)` is always available for manual / cron
  use regardless of whether `retention` is set. Mongo apps can still
  declare a server-side TTL index on the collection — both approaches
  coexist.
- Shared `repositoryAs*` helpers extracted to
  `src/adapters/store-helpers.ts` (`isNotFoundError`,
  `createSafeGetOne`, `createIsDuplicateKeyError`) — outbox + idempotency
  adapters lose ~76 lines of duplicated cross-kit error handling.
  Behavior unchanged.

**2.9.2 was unpublished.** Its `isReplyCommitted` guard did not fix the
reported race; 2.9.3 is the correct fix.

## 2.9.1

**Breaking — MongoDB wrapper stores removed.** `auditPlugin`,
`idempotencyPlugin`, and `EventOutbox` now take `repository: RepositoryLike`
directly — pass a `Repository` from mongokit / prismakit / your own kit.
Arc calls `create`, `getOne`, `findAll`, `deleteMany`, `findOneAndUpdate`
on it. Removed: `MongoAuditStore`, `MongoIdempotencyStore`,
`MongoOutboxStore`, and their `/audit/mongodb`, `/idempotency/mongodb`,
`/events/mongo` subpaths. Memory + Redis escape hatches unchanged.

**Breaking — routes API cleanup (pre-1.0).** `additionalRoutes` → `routes`,
`wrapHandler: false` → `raw: true`, `AdditionalRoute` → `RouteDefinition`.
`CrudRouterOptions.additionalRoutes` → `routes`. `TestHarness.runCrud()`
removed — use `HttpTestHarness.runCrud()`.

**`RepositoryLike` / `CrudRepository` additions**
- Optional `findOneAndUpdate(filter, update, options)`. `context.query` is
  the canonical filter field across all methods.
- Optional `isDuplicateKeyError(err): boolean` — kit-owned dup-key
  classification. Fallback is Mongo (`code 11000`), so mongokit ≤3.8 keeps
  working. Non-mongo kits implement to participate in idempotency.
- Optional `search?`, `searchSimilar?`, `embed?`, `buildAggregation?`,
  `buildLookup?` type hints (opt-in).

**`errorHandlerPlugin`** detects dup-key errors out of the box across
MongoDB (`11000`), Prisma (`P2002`), Postgres (`23505` — Neon/Cockroach),
MySQL/MariaDB (`ER_DUP_ENTRY` / `1062`), SQLite (`SQLITE_CONSTRAINT_*`).
`duplicateFields` extracted from each driver's native shape. Export
`defaultIsDuplicateKeyError` from `/plugins` for composition. Detection is
by driver codes only — never message strings.

**`searchPreset`** — `@classytic/arc/presets/search`. Mounts `POST /search`,
`/search-similar`, `/embed` without assuming a search backend. Auto-wires
from `repo.search` / `searchSimilar` / `embed` (verified against mongokit
3.6 native conventions). Explicit handlers win for Pinecone / Algolia /
custom. Zod v4 schemas pass through to AJV + OpenAPI.

**Pagination `TExtra` generic** — `OffsetPaginatedResult<TDoc, TExtra>`,
`KeysetPaginatedResult<TDoc, TExtra>`, `PaginationResult<TDoc, TExtra>`.
Opt-in for kit-specific metadata (tookMs, region, cursor version).
Defaults to `{}` — existing code unchanged. Added `warning?: string` for
deep-pagination hints.

**Other**
- MCP tools now emit for all custom + preset routes (no longer gated on
  `resource.adapter`).
- `filesUploadPreset.sanitizeFilename: boolean | '*' | fn` — relaxes
  default strict filename rules for microservice contexts.
- `multipartBody.allowedMimeTypes` accepts `'*'`, `'*/*'`, `type/*`.
- `idempotencyPlugin.namespace` folds into fingerprint for shared stores
  (prod + canary on one Redis).
- `webhooks.verifySignature` throws `TypeError` loudly when body is
  parsed instead of string/Buffer.
- Elevation plugin emits `arc.scope.elevated` on every elevation.
- `searchSimilar` auto-wire now passes single `VectorSearchParams` object
  (was positional — options were silently dropped).
- MCP custom-route handlers support inline function handlers.
- `src/events/outbox.ts` split into `outbox.ts`, `memory-outbox.ts`,
  `repository-outbox-adapter.ts`. Similar split for audit + idempotency.
- Peer: `@classytic/mongokit ≥3.8.0`.

```ts
import { Repository, methodRegistryPlugin, batchOperationsPlugin } from '@classytic/mongokit';

// Audit needs create + findAll — vanilla Repository works
await fastify.register(auditPlugin, {
  enabled: true,
  repository: new Repository(AuditModel),
});

// Idempotency + Outbox also need deleteMany → register batch-operations
const plugins = [methodRegistryPlugin(), batchOperationsPlugin()];

await fastify.register(idempotencyPlugin, {
  enabled: true,
  repository: new Repository(IdempotencyModel, plugins),
});

new EventOutbox({
  repository: new Repository(OutboxModel, plugins),
  transport,
});
```

## 2.8.5

- **Zod → Fastify schema fix** — `z.number().positive()` etc. no longer
  break route registration. `schemaConverter` defaults to `"draft-7"`
  (matches Fastify's AJV 8); OpenAPI generation keeps `"openapi-3.0"`.
  `toJsonSchema()` / `convertRouteSchema()` / `convertOpenApiSchemas()`
  take a `target` argument.
- **`filesUploadPreset`** — `@classytic/arc/presets/files-upload`. Raw
  `POST /upload`, `GET /:id` (with HTTP Range), `DELETE /:id`. Pluggable
  `Storage` contract (5 methods, 3 optional). No reference adapters ship —
  app source owns them. `runStorageContract()` for adapter conformance.
- **`multipartBody({ requiredFields })`** — returns 400 with
  `MISSING_FILE_FIELDS` if any listed field is absent. No-op for JSON.

## 2.8.4

- **MCP ↔ AI SDK bridge** — `bridgeToMcp()`, `buildMcpToolsFromBridges()`
  with include/exclude filtering.
- **`jobsPlugin` hardening** — wrapped with `fastify-plugin`, stalled-job
  bridge, `worker.pause()` on shutdown, repeatable/cron (`tz` required),
  large-payload warning (>100 KB), naive-ioredis detection, DLQ uses
  `-dead` suffix.
- **Redis adapters** — `ioredisAsCacheClient`, `upstashAsCacheClient`,
  `ioredisAsIdempotencyClient`, `upstashAsIdempotencyClient`. Edge
  runtimes work via upstash (REST).
- **`RedisIdempotencyStore.findByPrefix()`** batched (10 concurrent) with
  early termination — ~10× faster on high-latency Redis.

## 2.8.3

- Export `Guard<T>` / `GuardConfig<T>` from `/utils` (fixes TS4023).

## 2.8.2

- **`CrudRepository<TDoc>`** — tiered Required / Recommended / Optional.
- **Hard delete forwarding** — `?hard=true` → `repo.delete({ mode: 'hard' })`.
- **`RepositoryLike`** expanded (count, exists, distinct, bulkWrite,
  aggregate, withTransaction).
- **Actions** — per-action discriminated body validation (AJV enforces),
  Zod v4 / JSON Schema / field map, OpenAPI + MCP auto-generation,
  route-level `mcp: false`.
- **Outbox** — `claimPending`, `fail`, write options (session, visibleAt,
  dedupeKey), `RelayResult` per-kind counts, `publishMany` auto-detected,
  `exponentialBackoff()`, `OutboxOwnershipError`, `InvalidOutboxEventError`,
  `onError` callback. `delivered`/`deliveredAt` canonical.
- **`routeGuards`** on `defineResource()` — resource-level preHandlers
  auto-applied to every route. **`defineGuard()`** — typed preHandler +
  context pair with `guard.from(req)` type inference.
- Fixes: `slugLookup` fallback, restore hooks fire, fieldRules → OpenAPI
  parity, preset routes + `routes` merge correctly.
- Peer: `@classytic/mongokit ≥3.6.0`.

## 2.8.0

- `routes` replaces `additionalRoutes` (`raw: true` instead of
  `wrapHandler: false`). `actions` on `defineResource()` — declarative
  state transitions.

## 2.7.x

- **2.7.7** — WorkflowRunLike type fix, MongoKit 3.5.6 peer.
- **2.7.5** — CI fix, console cleanup, streamline execute/waitFor, MCP E2E.
- **2.7.3** — DX helpers, service scope, security fixes.
- **2.7.2** — Webhooks `verifySignature`, lifecycle cleanup, bounded concurrency.
- **2.7.1** — `allOf()` scope fix, `requireServiceScope`, MCP auth + org scoping.

## 2.6.x

- **2.6.3** — `idField` override end-to-end (AJV accepts custom PKs).
- **2.6.2** — Event WAL for durable at-least-once delivery.
- **2.6.0** — Audit trail plugin + stores, idempotency plugin.

## 2.5.5

- `createApp({ resources })`, `loadResources()`, bracket-notation filters,
  body sanitizer.

## 2.4.x

- **2.4.3** — Better Auth adapter, org scoping, role hierarchy, field-level perms.
- **2.4.1** — Initial public release.
