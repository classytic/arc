# Changelog — v2.11

**Summary**: `BaseController` mixin split, testing surface rewrite, resources factory form, WebSocket module split, action-router parity, commerce integration follow-ups (nullable, tenant-pipeline, SchemaBuilderOptions alignment).
**Sources**: CHANGELOG.md, wiki/log.md.
**Last updated**: 2026-04-25.

---

## v2.11.0 (current)

### Headline rewrites

- **`BaseController` → mixin composition.** `SoftDelete ∘ Tree ∘ Slug ∘ Bulk ∘ BaseCrudController`. `extends BaseController<Product>` still works (declaration-merged interface threads `TDoc`), but hosts that only need CRUD can extend `BaseCrudController<Product>` for an 869-LOC surface instead of the 1,650-LOC composed one. See [[core]] and [[gotchas]] #19.

- **Testing surface rewrite.** `@classytic/arc/testing` collapsed from 9 files / 3,320 LOC with fragmented adoption → 9 files / ~1,800 LOC with a single decision tree. Three primary entry points: `createHttpTestHarness` (auto-gen coverage), `createTestApp` (turnkey factory), `runStorageContract` (adapter conformance). Unified `TestAuthProvider`, DB-agnostic `TestFixtures`, fluent `expectArc` matchers. Removed: `TestHarness`, `authHelpers`, `dbHelpers`, old `testFactory` (1,535 LOC). See [[testing]].

- **Better Auth test helpers re-shipped.** Initial 2.11 rewrite deleted `createBetterAuthTestHelpers` / `setupBetterAuthOrg` on a "zero arc-internal consumers" metric; 24 downstream test files actually used them. Re-added as `setupBetterAuthTestApp` orchestrator composed over `TestAuthProvider`. DX lesson: survey downstream before removing public utilities.

- **Action-router parity via `routerShared`.** `createActionRouter` now installs `buildActionPermissionMw` in the canonical `permissionMw` slot of `buildPreHandlerChain` — same position CRUD uses. `buildActionPipelineHandler` returns `Promise<IControllerResponse<unknown>>` so pipeline errors preserve `{status, error, details, meta}` end-to-end. `buildAuthMiddlewareForPermissions` widened to `ReadonlyArray<PermissionCheck | undefined>` — omitted-public actions no longer 401. See [[core]] and [[gotchas]] #25.

- **WebSocket split.** `src/integrations/websocket.ts` (682-LOC monolith with 2 duplicated `fakeReply` shims) split into 7 focused submodules under `src/integrations/websocket/`. Auth handshake + re-auth loop share a single `authenticateWebSocket` boundary. `any` cast count: 7 → 1. Public entry is now a barrel. See [[gotchas]] #33.

- **`resources` factory form.** `resources` accepts a sync or async function that runs AFTER `bootstrap[]` — canonical answer to "my repository lives in an async-booted engine." Replaces per-resource lazy-bridge adapter boilerplate (~185 LOC typical). Contract: explicit `resources` (including function returning `[]`) wins over `resourceDir` auto-discovery. Lifecycle lock: `plugins → bootstrap → resources-factory → resources-registered → afterResources`. See [[factory]].

### Hygiene

- **`defineResource` never mutates caller's config.** Even on the no-preset path, a fresh shallow clone runs before `_appliedPresets` / tenant-field rule auto-inject. Pre-2.11 bug: hosts who factored a shared `baseConfig` and spread it across multiple `defineResource` calls saw the second call silently pick up state from the first. See [[gotchas]] #22.

- **`systemManaged` fields stripped from body `required[]`.** `stripSystemManagedFromBodyRequired` closes the Fastify preValidation gotcha where framework-injected fields (tenant, audit) were rejected before arc's injection hooks could run. See [[gotchas]] #20 and [[tenant-pipeline]] (debug guide at [docs/production-ops/tenant-pipeline.mdx](../docs/production-ops/tenant-pipeline.mdx)).

- **Schema-generation errors warn instead of silently passing.** `adapter.generateSchemas()` / `convertOpenApiSchemas()` throws now `arcLog.warn`. See [[gotchas]] #23.

- **`@classytic/arc/types` is truly type-only.** Value exports relocated: scope helpers → `@classytic/arc/scope`, `envelope` + `getUserId(user)` → `@classytic/arc/utils`. See [[gotchas]] #21.

- **`resourceToTools.ts` split into 4 units.** `crud-tools.ts`, `route-tools.ts`, `action-tools.ts`, `input-schema.ts`. `resourceToTools.ts` is now a 260-LOC orchestrator. See [[gotchas]] #24.

### Commerce integration follow-ups

- **`fieldRules[field].nullable: true`.** Rescues Zod `.nullable()` when the flag is lost through Zod → Mongoose (Mongoose has no first-class nullable marker unless `default: null` is also set). `mergeFieldRuleConstraints` widens both `type` and `enum` (AJV's `enum` rejects null unless in the list). Built-in mongoose fallback mirrors mongokit's `default: null` widening convention automatically. See [[gotchas]] #26 and [[adapters]].

- **`systemManaged` decision table.** Docs-only. [docs/framework-extension/custom-adapters.mdx](../docs/framework-extension/custom-adapters.mdx) "Field Rules" section lays out who sets the flag by field source: preset / engine-derived / request-scope / auto-ID.

- **`createMongooseAdapter` vs `createAdapter` clarified.** Former is the canonical arc export; latter is a CLI-scaffolded host wrapper in `src/lib/adapter.ts`. Hand-built apps should import `createMongooseAdapter` directly; scaffolded apps keep the wrapper for backend-swap ergonomics.

- **Tenant-field pipeline debug guide.** New [docs/production-ops/tenant-pipeline.mdx](../docs/production-ops/tenant-pipeline.mdx) walks the 5-stage pipeline (declare → autoInject → adapter schemagen → stripRequired → BodySanitizer) with file:line refs and a debug checklist. Answers "why did my tenant rule vanish?" without requiring code spelunking.

- **`RouteSchemaOptions extends SchemaBuilderOptions`.** Closes the last `Parameters<typeof buildCrudSchemasFromModel>[1]` cast at the host wiring site. Arc imports `SchemaBuilderOptions` + `FieldRule` from `@classytic/repo-core/schema` (peerDep `>=0.2.0`) and declares `ArcFieldRule extends FieldRule`. Hosts pass `schemaGenerator: buildCrudSchemasFromModel` directly — no wrapper lambda. Compile-time relationship locked in [tests/adapters/schema-builder-options-compat.test.ts](../tests/adapters/schema-builder-options-compat.test.ts) via 3 `AssertAssignable` checks. See [[gotchas]] #26 and [[adapters]].

## Related

- [[changelog-v2.10]]
- [[removed]]
- [[adapters]] — schemaGenerator zero-cast pattern
- [[core]] — mixin split, action-router parity
- [[testing]] — 2.11 testing surface
- [[factory]] — resources factory form
