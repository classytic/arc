# Presets

**Summary**: Composable resource modifiers. Attach one or more via `defineResource({ presets })`. Order matters when behaviors overlap.
**Sources**: src/presets/.
**Last updated**: 2026-05-18.

---

## Catalog

| Preset | Adds |
|---|---|
| `bulk` | Batch create/update/delete routes |
| `softDelete` | `GET /deleted` + `POST /:id/restore` routes; kit provides the `deletedAt` filter |
| `ownedByUser` | Row-level filter on `userId` |
| `slugLookup` | `/resource/:slug` in addition to `/:id` |
| `tree` | Parent-child recursion (category trees etc.) |
| `multiTenant` | Injects `organizationId` on CREATE **and UPDATE** (v2.9) |
| `audited` | Wires [[events]]/audit log for resource ops |
| `search` | Full-text search route |
| `filesUpload` | Multipart upload route, S3/local storage |

## Composition rules

- Presets compose, but **order matters**. `softDelete + bulk` both modify DELETE — latest wins.
- `tests/presets/preset-conflicts.test.ts` validates known conflicts. Always test combinations.

## softDelete — kit responsibilities

Arc's preset only adds the HTTP routes (`GET /deleted`, `POST /:id/restore`) and the `BaseCrudController` mixin that proxies them to `repo.getDeleted()` / `repo.restore()`. Every other piece — tombstone column, read-filter injection, hard-delete bypass, **and TTL auto-purge** — lives in the kit's soft-delete plugin. Wire the kit plugin on the repository, then attach `softDeletePreset()` to the resource. The two are independent and must agree on the column name.

| Kit | Soft-delete + TTL wiring |
|---|---|
| `@classytic/mongokit` | One plugin: `softDeletePlugin({ ttlDays })`. Creates a real MongoDB TTL index with `partialFilterExpression: { deletedAt: { $type: 'date' } }` so only tombstoned rows are swept. Mongo's TTL monitor runs every ~60s. |
| `@classytic/sqlitekit` | Two plugins. `softDeletePlugin()` handles tombstone + read filter. SQLite has no native TTL, so auto-purge ships as a separate `ttlPlugin({ field: 'deletedAt', expireAfterSeconds, mode })` with three modes: `scheduled` (setInterval sweep, default 60s, calls `.unref()` so it doesn't pin the event loop), `trigger` (`AFTER INSERT` SQL trigger prunes on writes, persistent across restarts), `lazy` (never deletes, just hides — pair with periodic `VACUUM`). `repo.sweepExpired()` exposed for Workers / Cron Triggers. |

For consumer-level coverage, see [tests/adapters/mongokit-soft-delete.test.ts](../tests/adapters/mongokit-soft-delete.test.ts) (HTTP round-trip + TTL index assertions) and [tests/adapters/presets-cross-kit.test.ts](../tests/adapters/presets-cross-kit.test.ts) (sqlitekit parity).

## multiTenant hardening (v2.9)

Prior versions ran tenant injection only on CREATE. A member could `PATCH /orders/:id { organizationId: <other-org> }` and move their own doc to another tenant. v2.9 runs injection on UPDATE too — body-supplied `organizationId` is overwritten with caller's scope. Elevated scope still bypasses for admin cross-tenant ops. See [[gotchas]] #12.

## Authoring

1. `src/presets/myPreset.ts` — factory returning `PresetDefinition`.
2. Export from `src/presets/index.ts`.
3. Tests in `tests/presets/my-preset.test.ts`.
4. Add conflict test in `tests/presets/preset-conflicts.test.ts`.

## Related
- [[core]] — `defineResource({ presets })`
- [[permissions]] — preset interactions
- [[events]] — `audited` preset emits
