# Testing

**Summary**: Vitest + `mongodb-memory-server`. Mirror src structure. Always run targeted tests; never the full suite during dev. Perf runs in its own lane. `test:main` = plain `vitest run` — vitest **projects** split the suite into `parallel` + `timing-serial` (files whose assertions depend on real elapsed time — websocket, and any other file in the `TIMING_SENSITIVE` holding pen — run with `fileParallelism: false` automatically; no manual `--no-file-parallelism` needed, ~40s wall clock). A file leaves the pen by replacing positive sleeps with condition-based waits; see the timing-lane section below.
**Sources**: tests/, vitest.config.ts, vitest.perf.config.ts, src/testing/.
**Last updated**: 2026-08-23 (tests/_harness + tests/parity — the cross-surface standard).

---

## Public test API (`@classytic/arc/testing`)

Four primary entry points, picked by what you're testing:

| Testing… | Use | Why |
|---|---|---|
| Framework behavior | `createHttpTestHarness` | Auto-generates CRUD + permission + validation tests against a live app. |
| Custom scenarios | `createTestApp` | Turnkey Fastify + in-memory Mongo + auth + fixtures; drive `app.inject()` yourself. |
| Adapter contracts | `runStorageContract` | DB-agnostic conformance suite for custom `Storage` implementations. |
| Module composability | `bootModuleApp` (2.22) | Real arc app around modules + in-memory Mongo — see section below. |

Shared primitives used across all of them:

- **`TestAuthSession` / `TestAuthProvider`** — unified auth (JWT, Better Auth, custom). `register(role, config)` → `.as(role).headers`. Replaces fragmented `createJwtAuthProvider` / `createBetterAuthProvider` / `TestRequestBuilder.withAuth`.
- **`TestFixtures`** — DB-agnostic record seeding. Register named factories; arc tracks inserted records for `.clear()` cleanup.
- **`expectArc(response)`** — fluent matchers for arc's response envelope (`.ok()`, `.forbidden()`, `.paginated()`, `.hidesField()`, `.hasMeta()`, etc.). Replaces ~6 assertion patterns repeated hundreds of times.
- **`mocks`** — `createMockRepository`, `createMockUser`, `createMockRequest`, etc. Stays as-is (most-used helper in the package).

See the [docs/testing/ site](../docs/testing/index.mdx) for the decision tree and usage examples.

## `bootModuleApp` — module composability harness (2.22)

Boots a REAL arc app around one or more [[modules]] and returns `{ app, uri, connection, exports, close }`. Upstreamed from the spine testkit; this is the ecosystem contract: **boots green in bootModuleApp ⇒ composes in any host.**

```ts
import { bootModuleApp } from '@classytic/arc/testing';

const t = await bootModuleApp(async ({ connection }) => [
  createAccountingModule({ connection, permissions }),
], { replset: true });          // replset: single-node replica set for transactional kernels
const engine = t.exports<AccountingEngine>('accounting');  // typed module-export accessor
await t.app.inject({ method: 'GET', url: '/accounting/accounts' });
await t.close();
```

- **DB-agnostic by seam**: the harness never names a driver — provisioning is the `database: TestDatabaseFactory` option (`TestDatabase = { uri, connection, teardown }`, structural). Default: exported `mongoMemoryDatabase` (in-memory MongoDB, lazy devDep imports; owns mongoose's DEFAULT connection *including a per-boot model-registry wipe* so multi-boot files never collide on kernel models). sqlitekit/pgkit testkits ship their own factory.
- `modules` may be a module, an array, or a **sync/async context factory** receiving `TestkitContext` (`{ uri, connection }` — the DB is live before module resolution starts; `mongoUri` is a deprecated alias of `uri`).
- **A bare function argument is ALWAYS the context factory**; module thunks ride inside arrays (`bootModuleApp([async () => createXModule(...)])`).
- `t.exports<T>(name)` — typed module-export accessor (delegates to `getModuleExports`; throws with the registered list on unknown names). Kills the `(t.app as ...).arc.modules.X` cast.
- Defaults `preset: 'testing'`, `auth: false`, `sensible: false`; override via `options.app`. Boot-failure cleanup (a throwing `createApp` tears the DB down), idempotent `close()`, `app.ready()` awaited (routes frozen post-boot, same as real apps). `bootModuleApp<TConn>` generic lets DB-typed facades pin the connection type once (spine-testkit = 39-line typed wrapper).

## Internal test bootstrap (`tests/setup.ts`)

arc's own test suite uses `tests/setup.ts` — a thin convenience layer over the public API. Exports:

- `setupTestDatabase` / `teardownTestDatabase` / `clearDatabase` — Mongo-memory-server lifecycle (arc's own tests bind to Mongoose because every adapter-free unit test flows through here).
- `setupGlobalHooks()` — wires `beforeAll`/`afterAll`/`afterEach` into the current `describe`.
- `createMockModel(name)` — arc's generic test Mongoose schema + registered model.
- `createMockRepository(model)` — real mongokit `Repository` against the given model.
- `mockUser`, `mockOrg`, `mockContext` — standard test fixtures.

Most adapter-free internal tests flow through this file. New tests should prefer the public API when the scenario fits.

## `tests/_harness/` — arc's OWN dev harness

Three homes, three audiences: `src/testing/` is SHIPPED (hosts), `@classytic/arc-testkit` is SHIPPED (ecosystem modules), `tests/_harness/` is arc's own and may reach into `src/` internals. Import from `tests/_harness/index.js`, never a leaf file.

- `arcApp(options)` — boots with `logger: false, auth: false` (the suite's measured defaults) and auto-closes in `afterEach`. Replaces the `let app` + manual-teardown preamble; teardown tolerates an already-closed app, so a test that closes early needs no bookkeeping.
- `arcAppRefuses(options, /regex/)` — one line for arc's most common shape, a boot-fatal misconfiguration.
- `anAdapter(seed)` / `aResource(name)` / `PERMS` / `aScope` — the fixtures the suite kept retyping. `aScope` covers all five `RequestScope` kinds; build scopes from it rather than inline, since the union is discriminated and hand-written members drift.

**No database helper here, deliberately.** A run-wide pooled `mongod` (vitest `globalSetup`) was built and measured against the status quo: SLOWER at both lane scale (10s vs 6s on `tests/adapters/`) and suite scale (75s vs 71s median), with much wider variance. Independent in-memory servers parallelize better than one contended server, and boot is cheap once the binary is cached. Files starting their own is the faster design, not debt — don't rebuild the pool.

## `tests/parity/` — one assertion, every surface

Arc serves the same resource over HTTP and MCP through two entry paths that re-implement the same decisions (identity → `RequestScope`, permission check, field projection, error envelope). The suite exercises those overwhelmingly on HTTP and rarely on both, and the cross-surface defects all lived in that gap. `forEachSurface(title, makeResource, body)` writes the expectation once with the transport as a parameter, so a divergence cannot be green anywhere.

```ts
forEachSurface("an anonymous WRITE is refused", guarded, async (surface) => {
  const r = await surface.call({ op: "create", body: { name: "x" } }, ANONYMOUS);
  expect(r.status).toBe(401);
});
```

- `surface.call` (CRUD) · `callAction` (declarative actions) · `callRoute` (custom routes) — all three MCP tool families.
- **Both surfaces are seeded from one `buildScope()`.** Setting `request.user` on HTTP and passing a session to MCP is NOT equivalent: HTTP mints the `member` scope in the auth plugin, MCP mints it from the session directly, so with `auth: false` the same identity yields different scopes and every tenancy assertion "diverges" for no transport reason.
- **The MCP surface must carry `wiring`.** Without it `buildContextExtras` returns `undefined`, `metadata.arc` is never stamped, and hooks, CRUD event publishing, and `BodySanitizer`'s field-WRITE enforcement all silently switch off — a degraded path that manufactures its own parity failures. The field-write parity test is the tripwire for this.
- Resources are built by a FACTORY per call, so one surface's mutation cannot leak into the other's run.

## Test mapping (by changed file)

Owned by [CLAUDE.md](../CLAUDE.md) — the `src/X/*` -> `tests/X/` default plus the handful of rows that need more. Not duplicated here; two copies drift.

## Why perf is isolated

`tests/perf/**` runs with `--expose-gc` and its own Vitest config. Keeping leak/perf assertions out of the shared heap prevents GC-noise false failures from unrelated tests.

## Writing tests

- Mirror source: `src/foo/bar.ts` → `tests/foo/bar.test.ts`.
- Mongo: `mongodb-memory-server` only. Never a real DB.
- HTTP: `createHttpTestHarness` (auto-gen) or `createTestApp` + `expectArc` (custom).
- Auth: `ctx.auth.register(...)` + `ctx.auth.as(role).headers`.
- OTel: `describe.skip` when `@opentelemetry/api` not installed.
- Test success AND failure. Error messages are part of the API contract.
- `toMatchObject` for partial assertions when docs have dynamic fields.

## Async assertions — never `sleep` then assert

```ts
await sleep(300);
expect(runs).toBeGreaterThanOrEqual(3);        // ✗ asserts a DURATION

await waitFor(() => runs >= 3, { label: "3 scheduler ticks" });   // ✓ asserts the CLAIM
```

A fixed delay encodes a guess about scheduling. Too short and it flakes the
moment the pool is busy; too long and every run pays for the worst case — and
because the guess is per-test, the failure lands on a different file each run and
reads as a product bug. Every flake chased in the 2.31 cycle was this shape.

A condition-based wait returns the instant the effect lands (so it is usually
*faster*) and can only fail with "this never happened", which is the thing worth
asserting. Pass `label` — a bare timeout reports only its own duration.

- `waitFor(fn, { label })` — `@classytic/arc/testing`. For values a test can observe.
- `fetchSSE(url, ceiling, until)` — for streams: ends on the awaited frame. Its
  `connected` promise resolves when the subscription exists server-side; await
  that before emitting rather than sleeping and hoping the subscribe won the race.

### Proving concurrency

`expect(elapsed).toBeLessThan(120)` to show three 50ms tasks ran in parallel
measures the RUNNER, not the code — a loaded pool pushed a genuinely parallel run
to 218ms, past the serial threshold it was meant to disprove. Count overlap
instead:

```ts
let inFlight = 0, maxInFlight = 0;
// in the handler: inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); … inFlight--;
expect(maxInFlight).toBe(3);   // they overlapped — the actual claim
expect(inFlight).toBe(0);      // and all settled
```

Genuinely wall-clock-bound suites (real sockets) are serialized via
`TIMING_SENSITIVE` in [vitest.config.ts](../vitest.config.ts). That list is a
holding pen, not a destination: **converting a file's waits is how it leaves.**
Widen the list rather than padding a sleep; shrink it by converting.

## Related
- [[commands]] — `test:main` vs `test:perf` vs `test:ci`
- [[architecture]] — which module a change lives in
