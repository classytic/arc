# Permissions

**Summary**: v2.10 split the `permissions/` module into `core`, `scope`, `dynamic`. Public import path `@classytic/arc/permissions` is unchanged.
**Sources**: src/permissions/.
**Last updated**: 2026-04-21.

---

## Layout (v2.10)

| File | Responsibility |
|---|---|
| `core.ts` | auth/role/ownership primitives + combinators: `allOf`, `anyOf`, `not`, `when`, `denyAll` |
| `scope.ts` | org/service/team/scope-context checks: `requireOrgMembership`, `requireOrgRole`, `requireServiceScope`, `requireScopeContext`, `requireOrgInScope`, `requireTeamMembership` |
| `dynamic.ts` | runtime permission matrices + cache + cross-node invalidation (~480 lines) |
| `fields.ts` | field-level read/write permissions |
| `presets.ts` | pre-composed permission bundles |
| `roleHierarchy.ts` | role inheritance tree |

## Combinators

```ts
allOf(checkA, checkB)      // AND
anyOf(checkA, checkB)      // OR
not(check, reason?)        // inverts result (v2.10)
when(predicate, check)     // conditional
denyAll('reason')          // always 403
```

## Scope-aware helpers

| Helper | Applies to scope kinds | Purpose |
|---|---|---|
| `requireOrgMembership` | member, service, elevated | Any org-bound |
| `requireOrgRole` | member | Humans-only role check |
| `requireServiceScope` | service | Machine OAuth-style scopes |
| `requireScopeContext` | member, service, elevated | Custom dimensions (branchId etc.) |
| `requireOrgInScope` | member, service, elevated | Hierarchy (parent-child orgs) |
| `requireTeamMembership` | member | Team membership |

Full matrix: `docs/getting-started/permissions.mdx`.

## Field-write denial (v2.9)

Default: `onFieldWriteDenied: 'reject'` — `ForbiddenError` listing denied fields. Opt in to silent `strip` per resource. See [[core]] and [[gotchas]] #11.

## Dynamic matrix

`permissions/dynamic.ts` computes permissions at runtime from a matrix config, with per-node cache and cross-node invalidation. Use when roles/permissions are DB-backed.

## Removed in v2.10
- `@classytic/arc/policies` — pluggable policy engine; `permissions/` covers every documented use case. See [[removed]].

## Related
- [[request-scope]] — input to every permission check
- [[auth]] — how scope gets populated
- [[core]] — where `BaseController` wires permissions in
