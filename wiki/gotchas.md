# Gotchas

**Summary**: Things that bite if you don't know about them. Each has a number used across wiki links.
**Sources**: AGENTS.md §6, CLAUDE.md.
**Last updated**: 2026-04-24 (v2.11 additions + #25 action-router parity).

---

1. **`request.user` is `undefined` on public routes.** Always guard `if (request.user)`. Required property (not optional) because `@fastify/jwt` declares it that way. See [[types]].

2. **`RepositoryLike` returns `Promise<unknown>`.** Intentional minimum contract; `BaseController` narrows internally. Don't tighten return types in adapters. See [[adapters]].

3. **Redis Streams are at-least-once.** Event transport doesn't dedupe; consumer crashes re-deliver. Handlers must be idempotent. See [[events]].

4. **`isRevoked` is fail-closed.** If the callback throws, the token is treated as revoked. Errors deny, never grant. See [[auth]].

5. **`select` is preserved as-is.** Never normalized to string — string/array/projection object all allowed. DB-agnostic by design. See [[core]].

6. **Type-only subpaths produce `export {}` at runtime.** `./org/types`, `./integrations` — correct output. Don't add runtime exports to fill them. See [[types]].

7. **Event publishing is fire-and-forget (`failOpen: true`).** Request succeeds even if publish fails. Use the outbox for guarantees. See [[events]].

8. **Event WAL skips `arc.*` internal events.** Prevents startup timeout with durable stores.

9. **CLI `init.ts` is ~3,400 lines.** Intentional — scaffolding templates are sequential. Don't split.

10. **Presets compose, but order matters.** `softDelete + bulk` both modify DELETE. Run `tests/presets/preset-conflicts.test.ts`. See [[presets]].

11. **Field-write denial is reject-by-default (v2.9).** `BodySanitizer` throws `ForbiddenError` listing denied fields. Opt into silent strip via `defineResource({ onFieldWriteDenied: 'strip' })`. See [[core]].

12. **multiTenant injects org on UPDATE too (v2.9).** Prior versions only ran on CREATE, letting members move their own docs. Body-supplied `organizationId` is overwritten with caller's scope. See [[presets]].

13. **Elevation always emits `arc.scope.elevated` (v2.9).** Subscribe for audit; `onElevation` callback still works. See [[request-scope]].

14. **`verifySignature(body, ...)` throws `TypeError` on parsed body.** Pass `req.rawBody`, not parsed `req.body`. Register `@fastify/raw-body` before webhook routes. See [[auth]].

15. **Plugins set response headers at `onRequest` or `preSerialization`, never `onSend` (v2.10.2).** Async `onSend` races with Fastify's flush path → `ERR_HTTP_HEADERS_SENT`. `isReplyCommitted()` in `src/utils/reply-guards.ts` remains for third-party plugin authors. See [[plugins]].

16. **MCP tools regenerate from resource config.** Changing field rules / permissions / routes changes tool schemas. Run `tests/integrations/mcp/`. See [[mcp]].

17. **MCP `auth: false` → `ctx.user` is `null`, not `"anonymous"`.** Guards still work correctly. See [[mcp]].

18. **`multipartBody()` is a no-op for JSON.** Safe to always add to create/update middlewares.

19. **`BaseController` is a mixin composition (v2.11).** `class MyCtrl extends BaseController<Product>` still works (declaration-merged interface threads `TDoc` through every method), but the surface is actually `SoftDelete ∘ Tree ∘ Slug ∘ Bulk ∘ BaseCrudController`. Hosts that only need CRUD extend `BaseCrudController<Product>` for an 869-LOC surface instead of the 1,650-LOC composed one. Shared helpers moved `private` → `protected` so mixins extend without duck-typing. See [[core]].

20. **`systemManaged` fields stripped from body `required[]` (v2.11).** Field rules with `systemManaged: true` are stripped from adapter-generated `createBody` / `updateBody` `required[]` arrays via `stripSystemManagedFromBodyRequired`. Closes the gotcha where Fastify preValidation rejected requests for framework-injected fields (e.g. `organizationId` via `multiTenantPreset` + engine `tenant: { required: true }`) before the preset's preHandler could inject. `multiTenantPreset` declares these rules automatically — no per-consumer `createEngine({ tenant: { required: false } })` workaround needed. See [[presets]].

21. **`@classytic/arc/types` is truly type-only (v2.11).** Value exports relocated: scope helpers (`AUTHENTICATED_SCOPE`, `PUBLIC_SCOPE`, `isAuthenticated`, `isElevated`, `isMember`, `getOrgId`, `getOrgRoles`, `getTeamId`, `hasOrgAccess`) → `@classytic/arc/scope`. `envelope` + `getUserId(user: UserLike)` → `@classytic/arc/utils` (root barrel still re-exports for DX). Don't import values from `/types` anymore — the old re-exports are gone. See [[types]].

22. **`defineResource` never mutates caller's config (v2.11).** Even on the no-preset path, a fresh shallow clone runs before `_appliedPresets` / tenant-field rule auto-inject. Pre-2.11 bug: hosts who factored a shared `baseConfig` and spread it across multiple `defineResource` calls saw the second call silently pick up state from the first. Regression-tested in `tests/core/v2-11-defineResource-hygiene.test.ts`. See [[core]].

23. **Schema-generation errors warn instead of silently passing (v2.11).** If `adapter.generateSchemas()` / `convertOpenApiSchemas()` / the query-schema merge throws, the resource still boots (non-fatal) but `arcLog("defineResource").warn(...)` now fires with the resource name + error. Pre-2.11 `} catch {}` hid contract drift between OpenAPI docs and runtime. Honors `ARC_SUPPRESS_WARNINGS=1`. See [[core]].

24. **`resourceToTools` split into 4 units (v2.11).** When editing MCP tool generation, go to the matching file — `crud-tools.ts`, `route-tools.ts`, `action-tools.ts`, or `input-schema.ts`. `resourceToTools.ts` is now a 260-LOC orchestrator; edits there should be rare. Shared helpers live in `tool-helpers.ts`. See [[mcp]].

25. **Action routes share the canonical preHandler order with CRUD (v2.11).** `createActionRouter` installs `buildActionPermissionMw` into the `permissionMw` slot of `buildPreHandlerChain` — same position CRUD uses. Ordering: `preAuth → arc → auth → permission → pluginMw → routeGuards`. Pre-2.11.0 the per-action permission check ran inside the route handler (after `pluginMw` + `routeGuards`), so `idempotencyMw` recorded unauthorized requests and guards saw unfiltered `request.scope` / `_policyFilters`. Three co-landing fixes: (a) `buildActionPipelineHandler` returns `Promise<IControllerResponse<unknown>>` so pipeline interceptors that fail with `{success:false, status, error, details, meta}` flow straight to the client with every field intact; (b) invalid-action 400s route through `sendControllerResponse` in both the prehandler and the defensive fallback — one wire shape; (c) `buildAuthMiddlewareForPermissions` accepts `ReadonlyArray<PermissionCheck | undefined>` and treats undefined as "public by omission" so `{ ping: undefined, promote: requireRoles([...]) }` doesn't 401 the public action. See [src/core/routerShared.ts](../src/core/routerShared.ts) and [[core]].

## Related
- [[rules]]? — see [[identity]] for non-negotiables
- [[security]] — checklist version of the auth-touching gotchas
