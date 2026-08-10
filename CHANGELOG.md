# Changelog

Release history index for `@classytic/arc`.

Detailed release notes now live under [changelog/](changelog/). This root file stays small and provides stable entry points for docs and references.

## v2

See [changelog/v2.md](changelog/v2.md) for the full v2 release history.

## 2.33

- [2.33.0](changelog/v2.md#2330) — **`NODE_ENV=prod` disclosed error internals and dropped `Secure` from session cookies.** Both defaults compared against the long spelling only, so a deployment spelling it `prod` shipped stack traces AND the raw thrown message of a 500 to clients (a Mongo connection string, verified against the wire), and sent session tokens over plaintext HTTP. Error disclosure had three independent leaks in one four-line assembly: a host passing ANY `errorHandler` key lost the preset-derived `includeStack`; `exposeInternalMessages` was never derived at all; and an UNSET `preset` read as development. Now a merge with both switches derived, explicit `preset` winning, absence falling back to the environment. Classification moved to `@classytic/primitives/environment` (`classifyEnv`/`isProduction`/`isTest`/`isDevelopment`, both spellings, trimmed) — four behaviour sites plus the `arc init` template migrated, **no raw `NODE_ENV` comparison left outside CLI templates**; peer floor `primitives >=0.21.0`.
- [2.33.0](changelog/v2.md#2330) — **Silent input drop closed on two paths.** An unknown filter key was DROPPED, and dropping a filter WIDENS — `?filters[status]=pending` returned 200 with every row `status:"verified"`, while `?status=pending` returned 0. A write to an `immutable` field was STRIPPED and reported 200 with the value unchanged. Both now refusable: `strictFilterFields` (`ARC_STRICT_QUERY_PARAMS`) throws `ValidationError`, `onImmutableWrite` (`ARC_STRICT_IMMUTABLE_WRITES`) throws `ForbiddenError`. Both **off by default** — arc is published and an unconditional throw would reject working requests; hosts opt in from their env-loader per the `ARC_STRICT_PERMISSIONS` precedent, and an explicit `false` beats the env.

## 2.32

- [2.32.0](changelog/v2.md#2320) — **Module disposers (`defer`)**, `extendModule` safe composition, `buildPermissionMatrix` from live registry, `createTestModuleSetup`, outbox-admin promoted to L5 with hardened operator gate.

## 2.31

- [2.31.0](changelog/v2.md#2310) — **⚠ `RouteDefinition.raw` removed — the FIELD carries the intent.** A route declared one `handler` plus a `raw: boolean` beside it saying how to call it, and BOTH mismatches were legal and untyped: a Fastify-shaped function without the flag was silently run through the pipeline, a pipeline handler with it was invoked as `(request, reply)`. Now `handler` is the arc pipeline `(ctx)` and **`rawHandler`** is Fastify-native `(request, reply)` — both also accept a controller-method name, declaring both throws at boot, and `streamResponse: true` requires `rawHandler`. Migration is mechanical (drop `raw: true`, rename that route's `handler`), and a LEFTOVER `raw` is **fatal at boot**, not ignored — tsc sees the flag only in sources recompiled against 2.31, not in a dependency whose published dist still emits it, so **every `@classytic/arc-*` package must be rebuilt against 2.31**. `streamResponse: true` now requires `rawHandler` (a `controllerMethod` route would otherwise be pipeline-wrapped and then fed to the streaming wrapper), the streaming wrapper preserves Fastify's instance as `this`, and `controllerMethod` is typed pipeline-only. New `check:route-api` gate in `prepublishOnly` scans src/docs/skills/wiki/examples for the removed flag — it exists because `arc init` kept EMITTING `raw: true` through a green typecheck (CLI templates are backtick strings, so the compiler checks the template, never the app it emits). This also restores inference: one field carrying every shape is a union of function types, which has no single contextual signature, so inline handlers reported TS7006; `rawHandler` is one method-syntax function type (`RawRouteHandler`, exported) whose bivariant parameters accept `FastifyRequest<{ Body: T }>` with no cast. Plus **the DB-agnostic rule is now machine-enforced** — `scripts/check-boundaries.mjs` (already in `prepublishOnly`) fails any static import of a driver or storage kit in `src/`, allowlisting only the two lazy in-memory-Mongo test imports with a reason; no source change was needed, arc's runtime deps stay `fastify-plugin`, `qs`, `secure-json-parse`. **⚠ Jobs hardening:** `GET /jobs/stats` + `/jobs/:id/status` were public and leaked `returnValue`/`failedReason` — the management surface is now **off by default** with a mandatory `operatorPermission` and redacted result/failure fields. New **`requirePlatformRole()`** — the gate must prove it is platform-only at boot, because `requireOrgRole("manager")` and the default `requireRoles(["ops"])` both grant on an ORG role with no policy, so no per-request check can distinguish them from a real operator gate. It is an operator surface, not tenant-facing — jobs carry no tenant identity, so a decision bearing a row `policy` is **refused** (`arc.jobs.policy_unsupported`) rather than silently ignored. Status is **queue-qualified** (`getStatus(queue, id)`, `GET /jobs/:queue/:id/status`) because BullMQ ids are queue-local; `dispatch()` returns a `JobHandle`. Duplicate job names and invalid numeric options (`maxConcurrent <= 0` never releases a semaphore slot) now fail at boot **before** any queue/worker is constructed. `scopeRoleGate` delegates to `requireOrgRole` — it matched `userRoles` while requiring an org, disagreeing with production whenever the two dimensions differ. Plus **deprecated aliases removed** (arc carries no deprecation shims): `applyPermissionResult`→`applyAuthorizationDecision`, `TestDatabase.mongoUri`→`.uri`, `mcpPlugin({ include })`→`expose`; the testing entrypoint drops `installTestActor` (never shipped; its body only threw) and promotes `scopeRoleGate` to its own module, replacing nine per-package copies that each returned the pre-2.30 `{ granted }` shape and silently denied — it requires an org by design, so pair it with `testActorHeaders('manager', ORG)`. A check returning the pre-2.30 `{ granted }` shape now **throws** instead of silently denying. Plus **static assets** via `createApp({ assets })`: a policy layer over `@fastify/static`. The reported "arc can't serve static data" was mostly a HEADER — arc's default helmet sets `Cross-Origin-Resource-Policy: same-origin`, so a browser discards a cross-origin embed despite a 200 and correct CORS; `crossOrigin` now overrides CORP **per prefix** without touching the API surface. Ranges/ETag/immutable/pre-compressed stay `@fastify/static`'s; arc adds secure defaults (`revalidate` cache, `attachment` disposition, dotfiles refused, `nosniff`) and boot-fails a duplicate prefix. New optional peer `@fastify/static >=8.0.0`. Plus **per-route CORS** (`RouteDefinition.cors` → `routeOptions.config.cors`) so one app policy no longer has to serve both an API and a public asset. **⚠ Peer floor correction:** `@classytic/primitives` `>=0.15.0` → `>=0.18.0` (`OutboxStore.transactionalSave`, absent from published 0.16.0) — primitives must publish first. Also: **Zod schemas convert by direction.** `z.toJSONSchema()` emits an input or an output shape and defaults to output; arc never passed the option, so a request body using `.default()` marked that field `required` and **rejected legal requests with a 400**, while a `.transform()` degraded to `{}` — validation switched off for that property. Request slots (`body`, `querystring`, `params`, `headers`, `createBody`, `updateBody`, `listQuery`) now convert as `input`; `response` and `entity` stay `output`. **⚠** a plain `z.object()` therefore stops emitting `additionalProperties: false` on request slots (Zod strips unknown keys rather than erroring — use `z.strictObject()` to reject them). `openapi-3.1` is mapped explicitly to `draft-2020-12` instead of falling through Zod's `({} & string)` escape hatch unrecognized. **⚠ Peer floor:** optional `zod` `>=4.0.0` → `>=4.4.0` (recursive-`.lazy()` stack overflow, `openapi-3.0` min/max intersections, object/tuple optionality). Plus **optional/deferred sibling-module reads** on `@classytic/arc/factory` — `getOptionalModuleExports`, `hasModuleExports`, `lazyModuleExports`, `lazyRequiredModuleExports`. `getModuleExports` throws, which is right for a required dependency and wrong for the two reads hosts actually had, so every host hand-rolled `(f as unknown as { arc?: { modules?: … } }).arc?.modules?.x` — a cast that loses registry typing and invites capturing a sibling engine ONCE at composition time, before it bootstrapped, which then reads as `undefined` forever and is indistinguishable from "that module isn't deployed". The lazy variants resolve at FIRST USE, memoize the resolved value, and never memoize absence. Plus **`describePermission` reports composed scope gates** — `allOf` merges children's `_scopeContext` and a new `scoped` requirement kind carries the dimensions, so an HQ-only gate no longer introspects as plain `admin`; introspection only, enforcement untouched.

## 2.30

- [2.30.0](changelog/v2.md#2300) — **⚠ Authorization standardization.** A `PermissionCheck` returns `boolean | AuthorizationDecision` (`allow()` / `deny()`) — decisions are pure data, evaluated by ONE transport-neutral core (`evaluatePermissionDecision`) and applied at ONE enforcement point (`applyAuthorizationDecision`); action + aggregation routes had been dropping policy filters and scope entirely. **Breaking:** `PermissionResult` and `normalizePermissionResult` removed (→ `AuthorizationDecision` / `normalizeToDecision`; `applyPermissionResult` stays as a deprecated alias). Policy filters now compose with **AND** (`conjoinPolicyFilters`) instead of a last-writer-wins spread that silently erased another layer's restriction, and are **normalized at the repository boundary** so arc's Mongo-style operator dialect stops throwing / silently matching nothing on SQLiteKit + PGKit. `ownedByUser` is **fail-closed** (no identity → deny; unowned record → deny unless `missingOwner: "allow"`) — check your `ownerField`, since a mismatched name made every record look unowned and pass. Plus static analysis without a request (`describePermission`, `explainAccess`, `collectPublicSurface`), `runAuthorizationConformance` proving CRUD and aggregation enforce identically, `scopeOf` for transport-neutral checks, and `strictPermissions` making an ungated write fatal. Also **`eventHandlers` gains an opt-in error `boundary`** (`boundary: true` or `{ onError }`) so a fire-and-forget module handler is contained without abandoning the 2.24 arm — off by default, because a throw reaching the transport is what leaves a Redis Streams message unacked so it redelivers and DLQs — and **`HookContext.scope`**, giving global hooks the same validated tenant/user projection `ResourceHookContext.scope` and `IRequestContext.scope` expose.

## 2.28

- [2.28.0](changelog/v2.md#2280) — **`OutboxStore` conformance suite** at the new stable subpath **`@classytic/arc/testing/outbox`** (`runOutboxStoreContract`): 21 tests over the six MUST invariants — atomic claim, expired-lease recovery, ownership errors, deterministic `fail`, malformed-event rejection, delivered-only `purge`. Any store can prove it honours the contract. Plus **`repositoryAsOutboxStore(repo, { visibleAtField })`** so a host adopts the shared adapter on an EXISTING outbox table with no column rename or index rebuild, and a test-only `MemoryOutboxStore.clear()`. All additive.

## 2.27

- [2.27.0](changelog/v2.md#2270) — **`@classytic/arc/cleanup` promoted to a STABLE subpath**, with the two pieces a host needs to implement its durability ports safely: **reference port implementations** (`MemoryCleanupRunStore`, `MemoryCleanupEvidenceStore`, `MemoryCleanupJobQueue` — same convention as `MemoryOutboxStore`; arc's own suite runs against them so they can't drift) and a **conformance suite** `runCleanupRunStoreContract` at the new **`@classytic/arc/testing/cleanup`** subpath. `CleanupRunStore`'s atomic guarantees (admission control, exclusive lease + crash recovery, lease-guarded CAS against a stale ex-owner, admission-guarded re-arm) are the only thing between a crash and a **double-executed destructive operation** — passing the suite IS the contract. **⚠ Peer floor fix:** `@classytic/primitives` `>=0.14.0` → **`>=0.15.0`** — cleanup imports `@classytic/primitives/canonical` + `/retention`, and neither subpath exists in 0.14.0 (a consumer on 0.14 failed at import with `ERR_PACKAGE_PATH_NOT_EXPORTED`); `@classytic/repo-core` `>=0.17.0`.

## 2.26

- [2.26.0](changelog/v2.md#2260) — **Data Cleanup Center framework** (`@classytic/arc/cleanup`) + **`purgeResource` `requireChunked` gate**. A thin recipe framework for destructive ERP cleanup (data-cleanup design §5/§6.5): `createDataCleanupModule({ recipes, runStore, evidenceStore, permissions, writeFence?, jobQueue? })` mounts a governance resource (`GET /recipes`, `POST /preview`, `POST /runs`, `GET /runs/:id`, `POST /runs/:id/action`, with Fastify JSON-Schema validation + fail-closed actor) over a `createCleanupService`. **Durable by contract:** `execute()` validates (availability, digest, confirmation, non-empty reason, **blocker hard-stop**, size limits) → ATOMIC single-run insert (`createIfPermitted`) → persists the sealed operation → enqueues a serializable `{ runId }`; a worker runs `processRun(runId)` OFF the request path. Every status change is a compare-and-set (`compareAndTransition`) so a late `completed` can't clobber a `cancelled`; **cooperative cancellation** rides a durable `cancelRequested` flag; **retry** reloads the sealed op + re-validates its digest (refuses a materially-changed plan); the **write fence** acquires in a guarded transition (a failed acquire never leaks a lock; a failed release never masks the outcome); **finalization** (terminal status + `PurgeEvidence` + immutable manifest) is idempotent by `operationId` and records FAILURE evidence too; progress is a BOUNDED summary (no unbounded per-chunk array); the plan/manifest checksum uses a STRICT canonicalizer (explicit `Date`, rejects `NaN`/`BigInt`/`Map`/`Set`/cyclic). `CleanupError` carries `statusCode` so arc's error handler maps `CLEANUP_*` codes to real HTTP statuses (verified by a Fastify injection test), never `arc.internal_error`. Arc owns the framework; recipes + statutory rules stay in the host + kernels. Also: `purgeResource` gains `requireChunked` — authoritative cleanup REFUSES the legacy unbounded `deleteMany` fallback (`arc.purge.chunked_required`); the org-delete cascade keeps its best-effort fallback (default `false`).

## 2.25

- [2.25.0](changelog/v2.md#2250) — **`scopeFirstCtx`** (`@classytic/arc/scope`): the shared scope-first actor/org context derivation for the `arc-*` module fleet — `request.scope` (userId/clientId + org) first, `x-organization-id` header only as the custom-auth/public bridge; `fallbackActorId` overload narrows to `{ actorId: string }`. Kills the 7+ per-package `ctxOf` derivation clones. **⚠ Breaking:** `@classytic/arc/schemas` moved to TypeBox 1.0 — optional peers `typebox@>=1` + `@fastify/type-provider-typebox@>=6` (was `@sinclair/typebox`); the `typeProvider: 'typebox'` option and `TypeBoxValidatorCompiler` export were removed (arc always validated with standard AJV). See [migration](changelog/v2.md#2250).

## 2.24

- [2.24.0](changelog/v2.md#2240) — **self-describing modules**: four additive composition arms on `ArcModule` (`healthChecks`, `eventHandlers`, `workflows`, `scheduledJobs`) so the host composition root stays thin. Modules carry their own readiness probes, event subscriptions, workflow defs, and interval jobs; arc collects them (dependency-ordered, boot-fail on duplicate names, per-owner provenance) and merges into the single health/schedule tables. Reuses the canonical `ScheduleDefinition`; DB/engine-agnostic (health `{name,check}`, transport-agnostic `fastify.events`, opaque workflows, pluggable repo-core `LockAdapter` for schedule leader-safety). New `./factory` + `./plugins` exports. **Breaking cleanup:** resource validators now import from `@classytic/arc/core`; the `/utils` re-export was removed. **Performance wave 12:** real load-shedding defaults, cache single-flight + jitter, multipart `maxTotalBytes`, two-phase outbox batch claim, Streams `processingConcurrency`, O(1) WS queue drain, bucketed health metrics. **⚠ Breaking:** outbox contract (`OutboxStore`, option types, `OutboxOwnershipError`, `InvalidOutboxEventError`) moved to `@classytic/primitives/outbox` — arc keeps the runtime only; peer `@classytic/primitives` >=0.13.0.

## 2.20

- [2.20.0](changelog/v2.md#2200) — domain **modules** (`defineModule` / `ArcModule<TExports>` / typed `getModuleExports`, thunk-of-dynamic-import lazy packs, **`dependsOn` stable topological composition order** with fail-fast cycle/missing/self/duplicate detection via `orderModules`, augmentable `ArcModuleRegistry` for cast-free `getModuleExports`), security-defaults wave (`readOnly()` write-deny, `crud-public-by-omission` diagnostic, MCP session-hijack + MCP aggregation tenant-scope fixes), approval/involvement presets extracted to `@classytic/arc-approval` / `@classytic/arc-involvement` pre-publish (subpaths never shipped), zod made truly optional for `actions:`, `check:peer-skew` release gate, un-driftable `arc init` pins, `./sync` subpath, peer floors primitives `>=0.9.0` / repo-core `>=0.7.0`.

## 2.19

- [2.19.0](changelog/v2.md#2190) — Application-Layer Encryption subpath (`/encryption`: JWE via lazy `jose`, field-level AES-256-GCM via `node:crypto`, `KeyProvider` + `kid` rotation), typed `ResourceExtensions` plugin hatch, better-auth `clone()` fix.

## 2.18

- [2.18.5](changelog/v2.md#2185) — adopt mongokit 3.16.1 PATCH-safety fix (update-body default stripping; e2e regression proving no PATCH default-injection) + production-grade `arc init` scaffold (typed Zod env, health/onClose, biome+CI).
- [2.18.4](changelog/v2.md#2184) — SSE lazy-auth fix.
- [2.18.3](changelog/v2.md#2183) — ecosystem sync (repo-core 0.6 / mongokit 3.16 / sqlitekit 0.6), `traceId` repo-option forwarding, BullMQ repeatable-schedule reconciliation, jittered Streams backoff + batch-scaled recovery, `configure()` rebuild state-loss fix, multi-node diagnostic-map leak fixes, internal refactor sweep (middlewares/crud/normalize splits), `prepublishOnly` runs `test:ci`.
- [2.18.2](changelog/v2.md#2182) — fix streamline DELETE route 500 (`Cannot read properties of undefined`) caused by unbound `delete`/`getById` repo method calls.
- [2.18.1](changelog/v2.md#2181) — remove phantom `disableCrud` type stub, `runtime: 'distributed'` error now names exact `stores.<key>` + fix hint, `TERMINAL_RUN_STATUSES` exported from `@classytic/arc/integrations/streamline`.
- [2.18.0](changelog/v2.md#2180) — durable WebSocket envelope + ack/replay (pushRef-registry, send-queue, dead-queue, outbound-truncate, safe-async), new `RedisPushRefStore` subpath for cross-instance pushRef state, H3-based **geo-room** spatial subscription manager (`h3-js` peer), `runInTransaction()` AsyncLocalStorage Unit-of-Work hook so kit adapters can thread DB sessions without per-function plumbing, **MCP realtime tool bridge** dispatching LiveKit/Gemini/OpenAI `LiveServerToolCall` frames through the existing MCP tool registry, request-id trace-context propagation, additional outbox provider tests. **Cleanup:** removed the phantom `disableCrud` flag from `defineResource` — it shipped in the type but was never read by the router, so it silently no-opped; `disableDefaultRoutes` (or `crud: false`) is the canonical kill-switch. **DX:** `runtime: 'distributed'` validation error now names the exact `stores.<key>` to set plus a per-key fix hint, instead of only listing what's absent.

## 2.17

- [2.17.0](changelog/v2.md#2170) — stabilization + security + arc-ai host-DX + pagination-cap envelope + reference-data shorthand. `secure-json-parse` on every untrusted JSON boundary (Redis sessions, Redis pub/sub + Streams, WebSocket frames, multipart text fields), idempotency fingerprint depth-cap against deep-nesting DoS, MCP `evaluatePermission` scope threading + exported `buildScope`, four new first-mount diagnostics for silent-drop misconfigs (`cache.invalidateOn` without `queryCachePlugin`, `audit: true` without `auditPlugin`, `events: {...}` without `eventPlugin`, `mcpPlugin` with `auth: false`), `FST_ERR_DUPLICATED_ROUTE` rewrap with `disabledRoutes` hint, auto field-write permissions on custom routes with `RouteDefinition.fieldWrite` opt-out, `GET /jobs/:id/status` + `JobDefinition.maxConcurrent` semaphore, `defineResource` overload that narrows `actions` to the captured literal shape, public `ResourceDefinition.warnings` getter for CI gating, **`pipeUIMessageStreamToReply()` + `UI_MESSAGE_STREAM_HEADERS`** (one-line AI SDK stream pipe — `streamResponse: true` now auto-pipes returned `ReadableStream`s instead of crashing with `chunk must be a string or Buffer`), **MCP tool-name collision detection** with source attribution + auto-namespace for preset-vs-user clashes (no more opaque `Tool already registered` from inside the MCP SDK), **`createMcpAuthFromBetterAuthApiKey()`** factory wrapping the `verifyApiKey` + metadata-org-scope dance every host kept reimplementing, **`customRoutesOnly: true`** shorthand on `defineResource` (replaces the `disableDefaultRoutes` + `skipValidation` + `skipRegistry` lockstep), **pagination-cap envelope** (a `?limit=200` violation against a `maxLimit=100` resource now responds 400 with a cap-aware top-level message AND machine-readable `meta.cap` + `meta.field` so callers can self-correct without scraping the message; per-detail `meta.bound` carries the AJV threshold for any `minimum`/`maximum` violation and `meta.allowedValues` for `enum`), **`referenceData: true` shorthand + resource-level `defaultLimit`/`maxLimit`** on `defineResource` (one flag for "fetch all, cache aggressively, no pagination UI" — expands to read-only `crud`, `defaultLimit/maxLimit: 1000`, `cache: { staleTime: 300, gcTime: 600 }`; the narrower `defaultLimit` / `maxLimit` knobs flow directly into the listQuery schema so a custom queryParser is no longer required just to set caps).

## 2.16

- [2.16.1](changelog/v2.md#2161) — DX patch: boot-time CRUD/custom-route collision detection, auto-envelope of bare handler returns, full `TenantPurgeStrategy` (with `reason` / `fields` / handler) exposed on audit surfaces, `preloadResources` discoverable from `/factory`, `FastifyInstance.arc?` augmentation reaches every entry-point barrel.
- [2.16.0](changelog/v2.md#2160) — breaking-changes minor: removed dead `/org` subpath, hardened validation pipeline, fixed streamline + queryParser + MCP DX traps, bumped kit peer floors.

## 2.15

See [changelog/v2.md#2153](changelog/v2.md#2153).

## 2.14

See [changelog/v2.md#2143](changelog/v2.md#2143).

## 2.13

See [changelog/v2.md#213](changelog/v2.md#213).

## 2.12

See [changelog/v2.md#212](changelog/v2.md#212).

## 2.11

See [changelog/v2.md#211](changelog/v2.md#211).

## 2.10

See [changelog/v2.md#210](changelog/v2.md#210).

## 2.9

See [changelog/v2.md#293](changelog/v2.md#293) and [changelog/v2.md#291](changelog/v2.md#291).

## 2.8

See [changelog/v2.md#285](changelog/v2.md#285), [changelog/v2.md#284](changelog/v2.md#284), [changelog/v2.md#283](changelog/v2.md#283), [changelog/v2.md#282](changelog/v2.md#282), and [changelog/v2.md#280](changelog/v2.md#280).

## 2.7.x

See [changelog/v2.md#27x](changelog/v2.md#27x).

## 2.6.x

See [changelog/v2.md#26x](changelog/v2.md#26x).

## 2.5.5

See [changelog/v2.md#255](changelog/v2.md#255).

## 2.4.x

See [changelog/v2.md#24x](changelog/v2.md#24x).
