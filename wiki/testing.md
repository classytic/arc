# Testing

**Summary**: Vitest + `mongodb-memory-server`. Mirror src structure. Always run targeted tests; never the full suite during dev. Perf runs in its own lane.
**Sources**: tests/, vitest.config.ts, vitest.perf.config.ts, src/testing/.
**Last updated**: 2026-04-24 (v2.11 testing surface rewrite).

---

## Public test API (`@classytic/arc/testing`)

Three primary entry points, picked by what you're testing:

| Testing… | Use | Why |
|---|---|---|
| Framework behavior | `createHttpTestHarness` | Auto-generates CRUD + permission + validation tests against a live app. |
| Custom scenarios | `createTestApp` | Turnkey Fastify + in-memory Mongo + auth + fixtures; drive `app.inject()` yourself. |
| Adapter contracts | `runStorageContract` | DB-agnostic conformance suite for custom `Storage` implementations. |

Shared primitives used by all three:

- **`TestAuthSession` / `TestAuthProvider`** — unified auth (JWT, Better Auth, custom). `register(role, config)` → `.as(role).headers`. Replaces fragmented `createJwtAuthProvider` / `createBetterAuthProvider` / `TestRequestBuilder.withAuth`.
- **`TestFixtures`** — DB-agnostic record seeding. Register named factories; arc tracks inserted records for `.clear()` cleanup.
- **`expectArc(response)`** — fluent matchers for arc's response envelope (`.ok()`, `.forbidden()`, `.paginated()`, `.hidesField()`, `.hasMeta()`, etc.). Replaces ~6 assertion patterns repeated hundreds of times.
- **`mocks`** — `createMockRepository`, `createMockUser`, `createMockRequest`, etc. Stays as-is (most-used helper in the package).

See the [docs/testing/ site](../docs/testing/index.mdx) for the decision tree and usage examples.

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

## Related
- [[commands]] — `test:main` vs `test:perf` vs `test:ci`
- [[architecture]] — which module a change lives in
