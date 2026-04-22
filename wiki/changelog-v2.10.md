# Changelog — v2.10

**Summary**: Permissions split, `RepositoryLike` stores, pagination fix, onSend race sweep, idempotency lock-leak fix.
**Sources**: CHANGELOG.md, recent commits.
**Last updated**: 2026-04-21.

---

## v2.10.3 (current)

- **Plugin onSend race closures fixed.** Final sweep of the v2.9.2 header-race bug — closures captured stale reply state under slow responses. See [[plugins]] and [[gotchas]] #15.
- **Idempotency lock-leak fix.** Store locks released on abort/timeout paths.

## v2.10.2

- **Types clean-break.** `src/types/index.ts` reorganized; no more legacy re-exports.
- **Repository adapters.** `RepositoryLike` now plugs directly into `EventOutbox`, `auditPlugin`, `idempotencyPlugin` — arc adapts internally. See [[adapters]].
- **Pagination fix.** Cursor pagination returned off-by-one in some edge cases.

## v2.10 (main release)

### Permissions split
`permissions/` divided into `core.ts` / `scope.ts` / `dynamic.ts` / `fields.ts` / `presets.ts` / `roleHierarchy.ts`. Public import path unchanged. New `not(check, reason?)` combinator. See [[permissions]].

### Removed
- `@classytic/arc/policies` — pluggable policy engine; `permissions/` covers every documented case.
- `@classytic/arc/rpc` — orphaned inter-service HTTP client.
- `@classytic/arc/dynamic` — `ArcDynamicLoader`; `factory/loadResources` is the only filesystem loader.

See [[removed]] for details.

## Related
- [[changelog-v2.9]]
- [[removed]]
- [[plugins]] — onSend rule
