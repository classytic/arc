# Contributing to @classytic/arc

## Setup

```bash
git clone https://github.com/classytic/arc && cd arc
npm install
npm run typecheck && npm run test:fast   # sanity: lanes below
```

Node.js ≥ 22, ESM only. No global installs required.

## The gates (run what you touched)

| Command | What it proves |
|---|---|
| `npm run typecheck` | Source compiles AND the type-assertion lane (`tsconfig.types.json`) compiles — type behavior is public API. |
| `npm run lint` | Biome (no ESLint/Prettier). `src/` must be clean at error level. |
| `npm run check:boundaries` | The layered module graph holds (no upward imports, no cycles). New top-level `src/` modules must be added to the LAYERS map. |
| `npm run check:api-surface` | Public surface matches `api-surface.json`. Removals on `stable` subpaths fail — see [GOVERNANCE.md](GOVERNANCE.md). |
| `npm run test:fast` / targeted `npx vitest run tests/<area>` | See the test-mapping table in [CLAUDE.md](CLAUDE.md) — run the minimum that covers your change; never the full suite during dev. |
| `npm run test:ci` | Release gate only (full suite + isolated perf lane). |

Test structure, lanes, and helpers: [tests/README.md](tests/README.md).

## Pull requests

A reviewable PR states, in the description:

1. **What invariant changed** — not just what code changed.
2. **API surface classification** — additive / compatible widening /
   deprecation / breaking. If `api-surface.json` changed, the PR must say
   why; breaking changes on stable subpaths need a ⚠ changelog entry with
   a migration note (see GOVERNANCE.md).
3. **Reliability impact** — for anything touching events, jobs,
   schedules, migrations, cache invalidation, idempotency, or webhooks:
   what happens on crash, retry, and concurrent replicas? The delivery
   matrix (`wiki/delivery-guarantees.md`) must stay truthful.
4. **Tests** — every behavior change lands with the test that pins it, in
   the source-oriented suite (one primary test file per production file;
   separate files only for genuinely separate lanes — contract, e2e,
   property). Name tests by the invariant they protect, never by version.

House rules that will come up in review (full list in
[CLAUDE.md](CLAUDE.md)): no `any`, no `@ts-ignore`, no default exports
(except `fp()`-wrapped plugin entries), no `console.log` in `src/`
outside `cli/`, no DB-driver imports anywhere in arc, prefer Node
built-ins, comments explain the current invariant — release history
belongs in `changelog/`, not source.

## Docs

`wiki/` pages are load-bearing (agents and maintainers read them instead
of re-reading `src/`). If your change invalidates a page: edit it, update
`wiki/index.md`, append one line to `wiki/log.md`.

## Security

Vulnerabilities go through [SECURITY.md](SECURITY.md), not public issues.
