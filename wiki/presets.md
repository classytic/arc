# Presets

**Summary**: Composable resource modifiers. Attach one or more via `defineResource({ presets })`. Order matters when behaviors overlap.
**Sources**: src/presets/.
**Last updated**: 2026-04-21.

---

## Catalog

| Preset | Adds |
|---|---|
| `bulk` | Batch create/update/delete routes |
| `softDelete` | `deletedAt` column + filtered queries |
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
