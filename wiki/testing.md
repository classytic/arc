# Testing

**Summary**: Vitest + `mongodb-memory-server`. Mirror src structure. Always run targeted tests; never the full suite during dev. Perf runs in its own lane. `test:main` = plain `vitest run` — vitest **projects** split the suite into `parallel` + `timing-serial` (files whose assertions depend on real elapsed time — websocket, and any other file in the `TIMING_SENSITIVE` holding pen — run with `fileParallelism: false` automatically; no manual `--no-file-parallelism` needed, ~40s wall clock). A file leaves the pen by replacing positive sleeps with condition-based waits; see the timing-lane section below.
**Sources**: tests/, vitest.config.ts, vitest.perf.config.ts, src/testing/.
**Last updated**: 2026-07-31 (condition-based waits — the flake standard).

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

44 internal tests import from this file. New tests should prefer the public API when the scenario fits.

## Removed in v2.11

- `TestHarness` (778 LOC) — Mongoose-bound "DB-agnostic" harness. 0 consumers. Full delete.
- `authHelpers` (`createBetterAuthTestHelpers`, `setupBetterAuthOrg`) — 372 LOC, 0 consumers. Full delete.
- `dbHelpers` (`TestDatabase`, `TestSeeder`, `TestTransaction`, `DatabaseSnapshot`, `InMemoryDatabase` exposed publicly) — 385 LOC. `InMemoryDatabase` absorbed as a private helper inside `testApp.ts`; everything else deleted.
- `testFactory`'s `TestRequestBuilder`, `request`, `createTestAuth`, `createSnapshotMatcher`, `TestDataLoader` — fragmented with `HttpTestHarness`'s auth providers. Collapsed into `TestAuthSession` + `expectArc`.

## Test mapping (by changed file)

Run the tightest subset. If you change file X, run the matching row. See CLAUDE.md for the full table.

| Changed | Run |
|---|---|
| `src/core/BaseController.ts` | `tests/core/base-controller.test.ts tests/core/access-control.test.ts tests/core/body-sanitizer.test.ts` |
| `src/core/QueryResolver.ts` | `tests/core/query-resolver.test.ts tests/e2e/query-*.test.ts` |
| `src/core/routerShared.ts` | `tests/core/router-shared-primitives.test.ts tests/core/action-router-parity.test.ts tests/security/action-router-auth.test.ts` |
| `src/testing/*` | `tests/testing/` |
| `src/auth/*` | `tests/auth/` |
| `src/permissions/*` | `tests/permissions/ tests/e2e/rbac-permissions.test.ts tests/scenarios/permission-presets.test.ts` |
| `src/scope/*` | `tests/scope/ tests/e2e/elevation-plugin.test.ts` |
| `src/events/*` | `tests/events/` |
| `src/plugins/*` | `tests/plugins/` |
| `src/presets/*` | `tests/presets/` |
| `src/integrations/mcp/*` | `tests/integrations/mcp/` |
| `src/factory/*` | `tests/factory/ tests/e2e/full-app.test.ts` |
| `src/utils/queryParser*` | `tests/utils/ tests/property/` |
| `src/auth/authPlugin*` | `tests/auth/ tests/property/jwt-bearer*` |

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
