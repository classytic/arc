# Testing

**Summary**: Vitest + `mongodb-memory-server`. Mirror src structure. Always run targeted tests; never the full suite during dev. Perf runs in its own lane.
**Sources**: tests/, vitest.config.ts, vitest.perf.config.ts.
**Last updated**: 2026-04-21.

---

## Harness & helpers (`src/testing/`)

- `HttpTestHarness` — full-stack HTTP round-trip tests.
- `createJwtAuthProvider` — auth-aware fixtures.
- `dbHelpers` — mongodb-memory-server lifecycle.
- Mock helpers for events, cache, hooks.

## Test mapping (by changed file)

Run the tightest subset. If you change file X, run the matching row. See CLAUDE.md for the full table.

| Changed | Run |
|---|---|
| `src/core/BaseController.ts` | `tests/core/base-controller.test.ts tests/core/access-control.test.ts tests/core/body-sanitizer.test.ts` |
| `src/core/QueryResolver.ts` | `tests/core/query-resolver.test.ts tests/e2e/query-*.test.ts` |
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
- HTTP: `HttpTestHarness`.
- Auth: `createJwtAuthProvider`.
- OTel: `describe.skip` when `@opentelemetry/api` not installed.
- Test success AND failure. Error messages are part of the API contract.
- `toMatchObject` for partial assertions when docs have dynamic fields.

## Coverage gaps (indirect only)

`context/`, `discovery/`, `idempotency/`, `registry/`, `testing/` itself. Covered by integration tests; no dedicated suites yet.

## Related
- [[commands]] — `test:main` vs `test:perf` vs `test:ci`
- [[architecture]] — which module a change lives in
