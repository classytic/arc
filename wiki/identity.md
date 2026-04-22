# Identity

**Summary**: Arc is a resource-oriented backend framework on Fastify. One `defineResource()` produces REST + auth + permissions + events + caching + OpenAPI + MCP.
**Sources**: CLAUDE.md, AGENTS.md §1.
**Last updated**: 2026-04-21.

---

## Shape

- v2.10.3 | Node.js 22+ | TypeScript 6+ | ESM-only | Fastify 5+
- Build: tsdown. Test: Vitest + mongodb-memory-server. Lint: Biome. Dead code: knip.
- Only required peer dep: `fastify >=5.0.0`. See [[peer-deps]].

## Philosophy

1. Resource-oriented — CRUD, schemas, auth, perms, hooks, events all hang off `defineResource()`.
2. DB-agnostic — core never imports mongoose/prisma. Adapters implement [[adapters|RepositoryLike]].
3. Primitives not opinions — building blocks (outbox, hooks, role hierarchy, scope), not workflow engines or mailers.
4. Optional peer deps, never bundled. dist must force-install nothing.
5. Tree-shakable — 88+ subpath exports. Users import `@classytic/arc/factory`, not root barrel.
6. No hardcoding — different DBs, auth systems, brokers, deploy targets.
7. Prefer Node built-ins — `node:crypto`, `structuredClone()`, `URL`/`URLSearchParams`.

## Non-negotiable rules

Violating these breaks users, the build, or the design.

- No `console.log` in `src/` outside `cli/` — use logger injection.
- No mongoose/prisma imports in core — adapter files only.
- No `any` — use `unknown`. `unknown` defaults are intentional.
- No `@ts-ignore` — fix the type (`as unknown as X` as last resort).
- No default exports — named only (knip enforces).
- No enums — `as const` objects or string literal unions.
- No ESLint/Prettier — Biome only.
- No CJS — ESM-only; CJS users use dynamic import.
- No bundling peer deps — `tsdown.config.ts` `deps.neverBundle`.
- No Dockerfile/Helm/K8s — app-level concerns.
- No saga/workflow orchestration — use Streamline/Temporal.
- No `--no-verify` on commit — fix the underlying failure.

## Related
- [[architecture]] — module map
- [[peer-deps]] — what's optional
- [[types]] — `unknown` defaults and why
- [[gotchas]] — the sharp edges
