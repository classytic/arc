# Arc test suite

~520 files / ~6,000 tests, full run ≈ 40s. Vitest, three projects
(`vitest.config.ts`): **parallel** (default), **ws** (WebSocket files,
auto-serialized), **perf** (isolated, `vitest.perf.config.ts`, own GC
lane). Type assertions compile in their own `tsc` lane — see below.

## Lanes

| Script | Scope | When |
|---|---|---|
| `test:fast` | core, hooks, utils, plugins, cache, events | inner loop |
| `test:contract` | `contract/` (incl. `.env`-gated live Redis), `adapters/` (real kits: mongokit, sqlitekit, pgkit, Better Auth), `types/` | adapter/API contracts |
| `test:integration` | `integrations/`, `factory/`, `auth/` | wiring against mocks (BullMQ, transports) |
| `test:e2e` | `e2e/`, `scenarios/`, `smoke/` | full apps over `inject()` |
| `test:reliability` | cache, events, migrations, schedules, health, breaker, compensation, jobs-timeout | the failure-safety surface |
| `test:changed` | `vitest run --changed` | pre-commit |
| `test:main` / `test:ci` | everything / everything + perf | release gate only — never during dev |

Targeted runs beat lanes during dev: `npx vitest run tests/<area>/file.test.ts`.
The change→suite mapping table lives in [CLAUDE.md](../CLAUDE.md).

## Directory taxonomy

- One **primary test file per production source file**, named for the
  invariant it protects (`policy-filter-fail-closed.test.ts`, never
  `v2-10-6-fixes.test.ts`). A second file only for a genuinely separate
  lane (contract / e2e / property / perf).
- `tests/<module>/` mirrors `src/<module>/` (e.g. `tests/integrations/` ↔
  `src/integrations/`). There is deliberately NO `tests/integration/`
  (singular) — real-kit suites live in `tests/adapters/`.
- `tests/contract/` — cross-package contracts and live external services.
  `redis-live.test.ts` runs against real Redis when `REDIS_URL` is set
  (copy `.env.example` → `.env`); it skips cleanly otherwise.
- `tests/property/` — fast-check property suites. `tests/security/` —
  attack-shaped inputs. `tests/perf/` — memory/GC budgets, isolated lane.

## Type tests are compiled, not just executed

`npm run typecheck:types` compiles `tests/types/**`, `*.test-d.ts`
contracts, AND every runtime test file containing `expectTypeOf` /
`@ts-expect-error` assertions — each is listed explicitly in
`tsconfig.types.json`. Vitest transpiles without type-checking, so a
type-assertion file that is NOT in that config proves nothing at the type
level. **If you add `expectTypeOf` to a file, add the file to the config
include list** (prefer putting compile-only contracts in `tests/types/`).
The lane runs in `npm run typecheck`, CI, and the release gate.

## `_support/` helpers

Use these instead of re-rolling per file (they expose behavior; they
never hide the scenario under test):

- `fastify.ts` — `useFastify()` returns `create()`/`track()` with
  automatic `afterEach` close of every instance (leak-proof even when a
  test throws).
- `logger.ts` — `silentLogger`; `recordingLogger()` when the test asserts
  WHAT was logged (`messages("warn")`).
- `deferred.ts` — `deferred<T>()`, `flushPromises()`, `wait(ms)` for
  concurrency choreography.
- `lock.ts` — `FakeLockAdapter` with real lease semantics (same-holder
  extends, expiry, `latencyMs`, `failNextAcquire`) for renewal/contention
  tests.
- `bullmq.ts` — `createBullmqMock(processors)`; pair with `vi.hoisted`
  exactly as documented in the file header. Prefer testing
  `executeTimedHandler` (jobs-execution.ts) directly — one wiring test
  per behavior is enough BullMQ mocking.

`tests/_helpers/` + `tests/setup.js` hold the older repository mocks and
DB harness (`setupTestDatabase` for mongodb-memory-server suites).

## Conventions

- `Fastify({ logger: false })` (or `useFastify()`) — tests must not emit
  request logs; CLI tests capture or silence stdout.
- Prefer `app.inject()`; real sockets ONLY for WebSocket/SSE transport
  behavior (those files auto-serialize via the ws project glob).
- Timing-sensitive tests (renewal cadences, grace windows) use generous
  margins — they run under full-suite CPU contention. Never run the full
  suite concurrently with builds.
- Fake timers: restore in `afterEach` (`vi.useRealTimers()`); remember
  vitest fakes `Date` too.
- At-least-once surfaces (events, jobs): assert idempotent-handler
  behavior, not single-delivery.
- Every external-review fix lands as a test named for the invariant, in
  the source-oriented suite — regression files are merged after the
  behavior stabilizes.
