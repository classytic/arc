# AGENTS.md — @classytic/arc

How to WORK on arc. One fact lives in one place:

| File | Owns | Loaded |
|---|---|---|
| [CLAUDE.md](CLAUDE.md) | session rules — commands, non-negotiables, type conventions, peers, test map, gotchas | always |
| **AGENTS.md** (this) | architecture, testing standard, security checklist, "adding a new X" | on demand |
| [wiki/](wiki/) | concept pages — how a subsystem works *now* | on demand, via [index](wiki/index.md) |
| [docs/](docs/) | HOST-facing guides (published site) | never in-session |
| [changelog/v2.md](changelog/v2.md) | what changed and why, per release | on demand |

**Nothing here restates CLAUDE.md.** If you want the non-negotiable rules, the peer table, or the targeted-test map, read that file — they are not duplicated below. Version numbers, test counts, and line counts appear nowhere: they rot.

---

## Philosophy

1. **Resource-oriented** — everything hangs off `defineResource()`. CRUD, schemas, auth, permissions, hooks, events flow from one config.
2. **Primitives, not opinions** — building blocks (outbox, hooks, scope, role hierarchy), never workflow engines or email senders.
3. **Fail-closed** — `isRevoked` errors deny; unauthenticated scope applies no tenant filter; auth-less actions throw at boot; an unreachable declaration refuses to register.
4. **Silence is the enemy.** A dropped filter, a stripped field, a verb nothing calls — each returns 200 and is invisible. Prefer a boot throw over a runtime warn, and a runtime warn over a silent drop.
5. **Optional by default** — every integration is a peer dep; `dist/` forces nothing beyond fastify.

## Architecture

`src/<subsystem>/` maps to a subpath export. Read `ls src/` for the inventory; what follows is what `ls` cannot tell you.

**Layering.** Modules form a DAG enforced by `npm run check:boundaries` (a release gate). Runtime imports may only point DOWN; type-only and lazy `await import()` are exempt (erased / deferred, so they cannot init-cycle). Adding an upward runtime import fails the build — that is the gate working, not an obstacle to route around.

Roughly: `utils`/`types`/`logger` (L1) → `core`/`permissions`/`scope` (L2) → `events`/`cache`/`hooks` (L3) → `plugins`/`integrations` (L4) → `factory` (L5, composes everything). `factory` may import anything; nothing imports `factory` at runtime.

**Boot order is fixed** — see the lifecycle table in CLAUDE.md. Do not reorder or skip slots.

**One implementation per rule.** When two places must agree (a matcher, an override detector, a page formula), extract it rather than mirroring it — a mirrored rule is a future divergence, and every divergence in this codebase's history was silent.

## Testing

**Workflow**
1. Read the source AND its tests before changing anything.
2. Fix a bug? Write the failing test first. It must fail for the stated reason before it passes.
3. Run the targeted tests from CLAUDE.md's table. Never the full suite during dev.
4. Before commit: `npm run typecheck` + `npx biome check src/ --diagnostic-level=error` + targeted tests.

**Writing tests**
- Mirror source structure: `src/foo/bar.ts` → `tests/foo/bar.test.ts`.
- Test the failure path and the error MESSAGE — messages are API contract.
- Assert on behaviour, not implementation. Reaching into privates is allowed only when the alternative tests a different unit; say so in a comment.
- Prove the test can fail. A guard that passes against a deliberately reintroduced bug is worse than no guard — it certifies safety it never checked.
- HTTP behaviour goes through `app.inject()`, not a controller call: route dispatch is where the wiring defects live.
- Never sleep-then-assert. Use `waitFor(fn, { label })` / `fetchSSE(url, ceiling, until)`; a fixed delay encodes a scheduling guess and fails on a different file each run. `TIMING_SENSITIVE` in `vitest.config.ts` is a holding pen — converting a file is how it leaves.
- `tests/perf/**` runs isolated (`--expose-gc`) so GC noise elsewhere cannot fail it.

**No redundant tests.** One behaviour, one owner. Before adding a case, check whether an existing file already covers it — a second assertion of the same fact costs suite time forever and fails twice for one cause. Prefer strengthening the existing test.

## Security checklist

When touching auth, permissions, MCP, idempotency, or data handling:

- [ ] `isRevoked` stays fail-closed (error = denied).
- [ ] Public routes guard `request.user` (it is `undefined` there).
- [ ] Hidden fields leak in neither responses nor MCP tool schemas — MCP and REST must enforce the same chain.
- [ ] Row-level filters from `requireOwnership` / tenant presets cannot be bypassed by query manipulation.
- [ ] Sensitive fields stripped before an event is published.
- [ ] `immutable` / `systemManaged` fields are never trusted from the wire.
- [ ] Idempotency fingerprints the body, so a replay with a different payload is rejected.
- [ ] Rate limits are scoped per tenant on multi-tenant resources.

## Adding a new X

- **Preset** — `src/presets/<name>.ts` returning a `PresetDefinition`; export from the barrel; test it, then test it COMPOSED in `tests/presets/preset-conflicts.test.ts` (order matters).
- **Plugin** — `src/plugins/<name>.ts` via `createPlugin()`; wire into `factory/` only if auto-loaded. Set response headers at `onRequest` or `preSerialization`, never `onSend`.
- **Event transport** — implement `EventTransport`; state the delivery guarantee in the file header; `subscribe` is optional (publish-only transports are legal).
- **Adapter** — lives in its KIT, never in arc. Implement `DataAdapter` from `@classytic/repo-core/adapter`; the kit owns the driver peer. Run arc's `tests/adapters/` against it for cross-kit conformance.
- **CLI command** — `src/cli/commands/<name>.ts` (the one place `process.stdout.write` is allowed); register in `src/cli/index.ts`.

## Conventions

- `requireXxxId(scope, hint?)` at handler boundaries instead of hand-rolled guards. Status splits by dimension: `requireUserId`/`requireClientId` → 401 (wrong principal); `requireOrgId`/`requireTeamId` → 403 (authenticated, no tenancy).
- Subclass authors: `ArcCreateResult<this>` / `ArcListResult<this>` etc. thread the concrete `TDoc` — no restating `Promise<IControllerResponse<T>>`.
- File names: `*Plugin.ts` = Fastify plugin, `types.ts` = shared types, `interface.ts` = type-only contract. Everything else follows its directory.
- Docblocks carry the WHY that code cannot: a measured defect, a rejected alternative, an ordering constraint. They do not narrate what the next line already says.

## Glossary

Only the terms that mean something specific here: **Resource** (a `defineResource()` config) · **Preset** (composable behaviour modifier) · **Scope** (`RequestScope`, the auth-state union) · **Transport** (event delivery mechanism) · **Outbox** (durable enqueue in the business transaction) · **Write verb** (a domain command bound to a CRUD slot) · **kit** (`@classytic/mongokit` | `sqlitekit` | `prismakit` — owns its driver and adapter).
