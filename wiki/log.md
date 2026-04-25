# Wiki Log

Append-only record of **wiki page** edits. Newest at bottom. Format: `YYYY-MM-DD — <page|all> — <wiki change>`.

This log tracks what's been documented in the wiki and why; release notes live in [`/changelog/v2.md`](../changelog/v2.md).

---

- 2026-04-21 — all — initial scaffold from CLAUDE.md + AGENTS.md (arc 2.10.3 baseline).
- 2026-04-24 — core — mixin-split surface documented (`BaseCrudController` + 4 mixins).
- 2026-04-24 — gotchas — added #19–24 covering 2.11 surface (mixin composition, `systemManaged` required-strip, `/types` cleanup, `defineResource` hygiene, schema-error warn, MCP file split).
- 2026-04-24 — core, gotchas — `createActionRouter` canonical preHandler order documented; gotcha #25 added.
- 2026-04-24 — testing — rewritten against the new `@classytic/arc/testing` surface (`createTestApp`, `TestAuthProvider`, `TestFixtures`, `expectArc`, `createHttpTestHarness`).
- 2026-04-24 — gotchas — added #33 for the websocket module split.
- 2026-04-24 — factory — documented `resources` accepting a sync/async factory function (between `bootstrap[]` and route wiring).
- 2026-04-24 — testing, removed — `createBetterAuthTestHelpers` / `setupBetterAuthOrg` / `safeParseBody` re-shipped; wiki sync.
- 2026-04-25 — adapters, gotchas — `fieldRules.nullable` documented; `default: null` widening on built-in mongoose fallback. Gotcha #26 (alongside `RouteSchemaOptions extends SchemaBuilderOptions`).
- 2026-04-25 — adapters — `RouteSchemaOptions extends SchemaBuilderOptions` (peerDep `>=0.2.0`); `ArcFieldRule extends FieldRule`. Documents the no-cast `schemaGenerator: buildCrudSchemasFromModel` wiring.
- 2026-04-25 — index, factory, events, plugins, removed — released wiki of historical changelog files (`changelog-v2.9/v2.10/v2.11.md` deleted; release notes belong under `/changelog/`). Cross-links updated to point at concept pages or the canonical changelog. Index "History" section collapsed to "API lifecycle" → `removed.md`.
- 2026-04-25 — factory — `loadResources({ context })` factory-export pattern documented; `silent` flag removal recorded with the arcLog fallback semantics (warn-by-default, suppressible via `ARC_SUPPRESS_WARNINGS=1` or per-call `logger` override).
