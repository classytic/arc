# Arc Examples

Runnable examples aligned with the current Arc API surface.

## Quick Reference (single-file)

- `01-minimal.ts` — Smallest resource setup with `defineResource` + `createMongooseAdapter`
- `02-basic-crud.ts` — Standard CRUD resource with presets and custom route
- `03-multi-tenant.ts` — Multi-tenant resource using `multiTenant` preset

## Full App (with test suite)

- `full-app/` — Complete app with JWT auth, two resources, permissions, presets, hooks, events, and a test suite

```bash
# Run the full-app test suite
npx vitest run examples/full-app/tests/
```

## Consumer smoke test

- `_consumer-smoke/` — installs the built package via `file:../..` and checks the public API as an external consumer (see its README)

### What full-app demonstrates

| Feature | Where |
|---------|-------|
| `createApp` with JWT auth | `app.ts` |
| `defineResource` with presets | `resources/user.resource.ts` |
| `requireOwnership` permission (admin bypass) | `resources/post.resource.ts` |
| Custom action route | `resources/post.resource.ts` (publish) |
| `allowPublic` / `requireRoles` / `requireAuth` | Both resources |
| Lifecycle hooks (`beforeCreate`) | Both resources |
| Event definitions | Both resources |
| Field rules / schema options | Both resources |
| Pagination, filtering, sorting | `tests/post.test.ts` |
| Permission enforcement (401/403) | `tests/user.test.ts`, `tests/post.test.ts` |

## Notes

- Use `createApp` from `@classytic/arc/factory`
- Keep examples focused on stable APIs
- All examples use `mongodb-memory-server` for tests — no real DB needed
