# Design: proven boot and the agent loop

**Status**: PROPOSED (2026-11-21). Plan only. Revision 4. Revisions 1 and 3 were each
reviewed against the code at `2968dd4`; both reviews overturned claims, and this revision
keeps only what survived. Citations marked (unchecked) come from an audit and were not
re-verified by a reviewer.

**One-line thesis**: consumers adopt what arc makes fatal at boot and skip what is
optional and silent. Make a service prove its own configuration at boot, make the
documented path the true one, and remove second ways. Most of this is corrections and
small extensions; arc is already ahead of its rivals where it counts.

## Context and evidence

Read-only studies on 2026-11-21: arc 2.52 internals; two consumers (A: 27 modules, 84
`defineResource`, arc 2.51; B: 12 modules, 23 host `defineResource`, arc 2.52); six
reference frameworks including NestJS 12 and Hono 4 (the NestJS clone had no docs, config
or health packages); an audit of arc's own debt; two adversarial reviews.

The incident, in consumer A: staging ran the production preset on a rehearsal database
with files on local disk. The config validator allowed it; the media module separately
switched the upload receiver off in production. The service booted, reported ready, and
returned HTTP 500 on the first photo upload. The client showed "server busy" with no
reference, although the server had sent one. One module's own contradiction, detectable
with no I/O. Its factory could have thrown at construction; nothing made that the
obvious thing to write.

### What two consumers show

| Observation | A | B |
|---|---|---|
| No module authors `healthChecks`; readiness cannot go not-ready | yes | yes |
| Own environment classifier, about 25 decision sites | yes | yes, two that disagree |
| `readEnv` unused; rules live apart from the modules that consume the values | yes | yes, unenforced at runtime |
| `errorHandler.onError` unwired; no client reads `correlationId`; header not exposed | yes | yes |
| Tracing never registered | yes | yes |
| `rawHandler` dominates custom routes | 99 | 82, plus 61 unchecked request casts |
| Rate limit keyed by IP only | yes | no: user, then IP |
| Hand-ordered composition | yes | no: `dependsOn` |

B adopted `runtime`, ports, the outbox module, idempotency and `dependsOn`: features that
fail boot when misused. Neither adopted the optional, silent ones. Each has a list of
"boots ready, fails at first use" risks (A: 10, B: 8).

### Where arc is ahead (do not rebuild)

Resource density (one file of about 45 lines against about 12 files in NestJS's own
samples); agent docs shipped and size-gated; an error body with code and correlation id;
a generated test harness; cache keys that carry user and organisation with a CDN tier
that fails private on credentials; write events driving invalidation and CDN purge;
boot-fatal checks for memory-backed state under a distributed runtime.

### What the reviews corrected

- A function `handler` already runs the full pipeline and produces the MCP tool
  (`src/types/resource/routes.ts:31-49`, `src/integrations/mcp/resourceToTools.ts:254-263`),
  and typed generics exist (`src/types/handlers.ts:281-286`). Only inference from the
  `routeInput` schema is missing. The skill teaches `rawHandler`
  (`skills/arc/SKILL.md:62-65`) although the better form exists.
- An ungated write is already fatal: `strictPermissions` is on
  (`src/core/defineResource.ts:150`). Ungated reads are only `info`.
- `cachingPlugin` emits `public` only when a host sets `maxAge > 0` without `private`
  (`src/plugins/caching.ts:77-106`). It is auth-blind in that case, not by default. Six
  other places also set `Cache-Control`; "one emitter" was not achievable as written.
- Module `healthChecks` are static and collected before Fastify exists
  (`src/factory/createApp.ts:376-380`). There are no "composed options" to pass to a
  check, and `HealthCheck` is the polled readiness shape shared with workers.
- `classifyEnv` exists and `int` already rejects bad values in primitives.
- Span names, a fatal untrusted proxy, the rate-limit key and exposed headers are
  observable behaviour. None is "safe now".

## The decision (bottleneck test)

An item is in when it cost real time in a consumer, removes a class of failure, can be
checked mechanically, and extends an existing concept. Ranked:

1. The documented path is not the true path: the skill teaches the bypass; docs import
   about 30 names that are not exported and show a removed response envelope (unchecked);
   `v3.md` sketches APIs its own text rejects.
2. A service can boot and report ready while its own configuration contradicts itself.
3. The error reference stops at the server.
4. Second ways: 5 route-handler spellings, 4 CRUD-disable spellings, 3 functions named
   `getUserId`, 2 `HealthCheck` types.
5. Arc's own gates skip its own checks in CI.

## Contracts and surface

### 1. True golden path (docs only)

- The skill's custom-route example uses a function `handler`. `rawHandler` is named as the
  escape hatch for streams, raw-body webhooks, files and redirects, which need it.
- Cuts are named in the same change; the skill body is at 6,139 of 6,144 bytes.
- The skill documents `httpCache`, absent today.

### 2. Module invariants (new arm, not `healthChecks`)

```ts
defineModule({
  name: 'media',
  facts: { driver: 'local', uploadReceiver: false },
  invariants: [
    { code: 'media.upload-receiver', fix: 'enable the receiver or use a cloud driver',
      check: (facts) => facts.driver !== 'local' || facts.uploadReceiver },
  ],
});
```

- `facts`: a static, serialisable declaration of the decisions a module made from
  config. No secrets.
- `invariants`: pure functions over facts. Evaluated once, before any I/O. Fatal under
  every preset. A separate arm because an invariant never polls and has no timeout.
- Cross-module invariants read other modules' facts by name.
- `arc describe` prints facts and invariants without booting, so they can be checked
  with no database.
- Not included: `atBoot`. Instead all registered health checks run once at the end of
  boot and the result is logged.

### 3. One coded boot report

Requirement errors, the runtime-capability audit, resource diagnostics and invariants
each throw today, some as plain `Error` with no code
(`src/utils/runtimeCapabilities.ts:143`). One report: every boot failure carries a stable
code, the module name and a fix line. Scoped as its own item because it touches three
existing audits.

### 4. Error reference end to end

- The 500 log record gains code, route and method (`src/plugins/errorHandler.ts:313`).
- `x-request-id` in the default exposed headers (marked minor: consumer B pins the
  header list in a test).
- `arc-next` and client error types carry `correlationId`.

### 5. Handler input inference

A type-only wrapper that mirrors `defineAction` (`src/core/defineAction.ts:74-87`) and
returns the same runtime object as a function `handler`. It reuses `IRequestContext`; no
new context shape. A wrapper is unavoidable for the typing, so it counts as a form: the
surviving handler spellings are decided first (open question 1).

### 6. Cache: close the auth-blind case and prove invalidation

- `cachingPlugin` does not emit `public` for a request that carries credentials. Marked
  minor.
- ETag matching handles lists, weak validators and `*`.
- A two-instance conformance test: a write on one node invalidates the other and purges
  once.

### 7. Tracing fix (marked minor)

Span name from the route template, current OpenTelemetry HTTP keys, packages loaded
separately so one missing package does not disable everything
(`src/plugins/tracing.ts:86-111, 256-264`). It renames what existing dashboards see.

### 8. Env reader, real delta only (primitives)

Collect every problem and throw once; required-in-production with no silent default;
pair rules; a `secret` marker exported for logger redaction.

### 9. Verify command (arc-testkit)

Runs invariants from `arc describe` first, then boots on in-memory Mongo for the
generated harness and conformance suites. Depends on section 2.

## Cleanup program

Arc's source is in good shape. The debt is in docs, `v3.md`, public aliases and what no
gate covers. Each item ends with a gate.

**Safe now (no public or observable change)**

| What | Gate |
|---|---|
| `docs/`: dead imports, removed response envelope, stale migration page | extend the skills identifier check to `docs/`, `README.md`, `examples/` |
| `v3.md`: sketches it rejects; items already shipped or removed; `raw: true` sketches where the code uses `rawHandler` | banned-identifier list from its own "Dropped" section |
| Prose that says strict defaults are off | a test asserting documented defaults against code |
| The skill golden path (section 1) | `check:skills` |
| 500 log record fields | unit test |
| Repo root: dangling symlink, tracked test artifact, unused `.npmignore`, stale knip entries | root allowlist check |
| CI runs every `check:*` (it omits `check:skills`, `peer-skew`, `docs-drift`, `route-api`, `forgotten-exports`, `line-endings`) | the workflow itself |
| Mirrored helpers that are not exported | duplicate-declaration check |
| Version-history comments in `src` (unchecked count) | the skills banned-wording list applied to `src` |
| `GOVERNANCE.md` experimental list matches `package.json` (adds `./http-cache*`, `./outbox-admin`) | a sync check |

**Needs a marked minor** (per GOVERNANCE: a marked entry with a migration note, an
`api-surface.json` update, and a one-minor deprecation window where feasible)

| What | Note |
|---|---|
| Tracing span names and keys; exposed `x-request-id`; `cachingPlugin` and credentials | observable behaviour |
| Remove compat aliases (`roles()`, the `permissions` namespace alias, `EventOutbox.relay()`, `wal`, `toolNames`, `getStore()`, `allowUnfencedCompletion`) | deprecate for one minor first |
| One CRUD-disable spelling (`crud`) | `customRoutesOnly` also sets `skipValidation` and `skipRegistry`; it is not only a spelling |
| Rename colliding MCP guards (`getUserId`, `requireAuth`, `guard`); one `HealthCheck` type | public `./mcp`, `./types` |
| Peer caps (`fastify >=5.12.8 <6`), OpenTelemetry floors, drop the MongoDB instrumentation peer | consumer installs |
| Collapse handler spellings and mirrored exports | `v3.md` puts breaking changes in marked minors; this need not wait for v3 |

**v3 only**: `ArcModule.plugins` to `setup`; Node 24 and Fastify 6 floors.

**Settled (2026-11-21, owner)**: `allowPublic` keeps its name. No rename to
`publicAccess`. Used in both consumers (A: 2 routes; B: 45 mentions in 13 files) and
across arc. The `v3.md` cleanup removes the rename row and keeps the lines that retain
the name.

## Where each piece lives

| Piece | Home |
|---|---|
| Facts and invariants, boot report, error log fields, handler inference, cache and tracing fixes, skill | arc |
| Env reader delta; a neutral check type kits can use | primitives |
| Health check factories (storage, mail, push, queue) and the attachment flow | each kit |
| Verify command | arc-testkit |
| `correlationId` on the client | arc-next and client SDKs |
| Cross-node single-flight | repo-core, with the CacheEngine façade `v3.md` decided |
| Exporter and log-store setup | docs recipe |

## Phases

| Phase | Scope |
|---|---|
| 0 | In both consumers, no arc change: each module's factory throws on its own contradictions; module health checks; `onError`; show the error reference; move custom routes to a function `handler` |
| 1 | "Safe now" cleanup with its gates, including the skill golden path |
| 2 | Facts and invariants; coded boot report; env reader delta; two-instance cache test |
| 3 | Marked minor: tracing, exposed header, cache and credentials, alias deprecations; handler inference once the surviving spellings are decided |
| 4 | Verify command |

## Conformance

- Both consumers' risk lists replayed: each static contradiction fails boot with a code
  and a fix line; each unproven credential shows in a health check.
- Docs, examples and `v3.md` pass the identifier gate with zero unknown names.
- From a client error reference to the server log record in one search.
- The skill stays inside its byte ceiling.
- A measure of what an agent reads and how often it passes first time on fixed tasks,
  tracked outside the release gate. Nothing else here tests the primary goal.

## Non-goals and traps

- No `probes`, `atBoot`, `profile` enum, config builder, `liveData` flag, second error
  hook, or docs link in the error `meta` (a wire change).
- No purger-as-capability: a no-op purger is correct for browser-only caching.
- No runtime warning for empty readiness. Arc's own code notes that warnings nobody can
  act on get filtered; `arc doctor` reports it.
- No decorator dependency injection, class-validator DTOs, exception-filter classes or
  per-route OpenAPI declarations.
- No typed client inference and no edge gateway kit in this plan. Both are real ideas
  with no consumer asking yet.
- Not moving arc onto edge runtimes or off Fastify.
- Not caching personalised responses at the CDN through `Vary`.
- No log store, dashboard, APM or `arc-otel` package.

## Decisions (2026-11-21, delegated by the owner)

1. **Handler spellings.** Two survive: a function `handler` (the normal form: full
   pipeline, MCP tool) and a function `rawHandler` (streams, raw-body webhooks, files,
   redirects). The string forms and `controllerMethod` are deprecated in a marked minor
   with a one-minor window, then removed. Consumer B's 3 `BaseController` uses migrate
   to a function `handler` that calls the controller.
2. **Ungated reads.** With `strictPermissions` on, an ungated read fails boot like an
   ungated write; intent is stated with `allowPublic()`. Marked minor. Public catalogs
   stay one word away; an accidental public read does not ship.
3. **Rate-limit key.** Signed-in requests are keyed by user; anonymous requests by IP.
   One office Wi-Fi or carrier NAT then never throttles colleagues together, and
   sign-in, sign-up and reset (no user yet) keep the per-IP limit that slows password
   guessing. The early per-IP ceiling stays, set high. Marked minor; the skill shows
   the `strategy` option. Consumer B already runs this.
4. **Untrusted proxy.** Stays a warning. Many deployments have no proxy, and boot cannot
   tell. `arc doctor` reports it.
5. **Readiness detail.** Check names and status only by default; error text goes to the
   log. Health registers before auth, so this is the only safe default.
6. **Neutral check type.** A type in primitives. Kits import the type, not arc.
7. **CRUD-disable spelling.** `crud` is the one form (the code already calls it the
   documented default). `disabledRoutes` and `disableDefaultRoutes` are deprecated with
   a window. `customRoutesOnly` stays: it also sets `skipValidation` and `skipRegistry`,
   so it is a different intent, not a spelling.
8. **Docs-only follow-ups** (safe now): renumber the examples (two files are `01`), fix
   the stale test title about stripped immutable fields, update the boot warning that
   still calls strict permissions "the arc v3 default" together with the test that pins
   it, drop `strictFilterFields` from the querying reference if mongokit has no such
   option, and finish the four leftover inconsistencies in `v3.md`.

## Before removing the deprecated forms (decided 2026-11-21, delegated by the owner)

Two gaps found in the 2.53 deprecation pass, both closed in 2.53.0.

**A. String handlers inside presets.** The controller is passed to preset route
builders: `routes(permissions, controller)`. Presets apply before the controller is
resolved (they feed `controllerOptions` into the auto-built `BaseController`), so
`defineResource` hands them a handle that it binds once the controller exists; each
method resolves per request. Methods read while the routes are built
(`handler: controller.getBySlug`) are verified after binding, so a missing method or
controller fails boot (`preset-controller-method-missing`), as string handlers did. Arc's
`bulk`, `slugLookup`, `softDelete` and `tree` use that reference form. A host preset that returns a string `handler`, string `rawHandler`
or `controllerMethod` warns once, naming the preset, and is removed with the
resource-level forms. A one-argument `routes(permissions)` keeps working.

**B. "No HTTP CRUD but these MCP tools".** No new option. The one way is `crud: false`
(or a `crud` allow-list) on the resource plus
`mcpPlugin({ overrides: { <resource>: { operations: [...] } } })`, verified by a test
(`crud: false` + `operations: ['list', 'get']` yields exactly `list_*` and `get_*`
and no HTTP CRUD routes). Documented in the MCP guide, the MCP skill reference and the
`crud` migration note.

## Found during the 2.53 consumer re-check (2026-11-21)

Both shipped in 2.53.0: preset routes are never public by omission (`preset-route-public-by-omission`), and the multiTenant guard covers preset and custom `handler` routes.
