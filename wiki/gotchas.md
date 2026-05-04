# Gotchas

**Summary**: Things that bite if you don't know about them. Each has a number used across wiki links. Evergreen only — version-tagged behavior changes belong in [`/changelog/v2.md`](../changelog/v2.md).
**Sources**: AGENTS.md §6, CLAUDE.md.
**Last updated**: 2026-05-03 (pruned v2.11 history; #19–26 retired now that the new behavior is the only behavior).

---

1. **`request.user` is `undefined` on public routes.** Always guard `if (request.user)`. Required property (not optional) because `@fastify/jwt` declares it that way. See [[types]].

2. **`RepositoryLike` returns `Promise<unknown>`.** Intentional minimum contract; `BaseController` narrows internally. Don't tighten return types in adapters. See [[adapters]].

3. **Redis Streams are at-least-once.** Event transport doesn't dedupe; consumer crashes re-deliver. Handlers must be idempotent. See [[events]].

4. **`isRevoked` is fail-closed.** If the callback throws, the token is treated as revoked. Errors deny, never grant. See [[auth]].

5. **`select` is preserved as-is.** Never normalized to string — string/array/projection object all allowed. DB-agnostic by design. See [[core]].

6. **Type-only subpaths produce `export {}` at runtime.** `./org/types`, `./integrations` — correct output. Don't add runtime exports to fill them. See [[types]].

7. **Event publishing is fire-and-forget (`failOpen: true`).** Request succeeds even if publish fails. Use the outbox for guarantees. See [[events]].

8. **Event WAL skips `arc.*` internal events.** Prevents startup timeout with durable stores.

9. **CLI `init.ts` is large and intentionally monolithic.** Scaffolding templates are sequential string emission; splitting fragments the templates without buying anything. Don't split.

10. **Presets compose, but order matters.** `softDelete + bulk` both modify DELETE. Run `tests/presets/preset-conflicts.test.ts`. See [[presets]].

11. **Field-write denial is reject-by-default.** `BodySanitizer` throws `ForbiddenError` listing denied fields. Opt into silent strip via `defineResource({ onFieldWriteDenied: 'strip' })`. See [[core]].

12. **multiTenant injects org on UPDATE too.** Body-supplied `organizationId` is overwritten with caller's scope — prevents tenant-hop. See [[presets]].

13. **Elevation always emits `arc.scope.elevated`.** Subscribe for audit; `onElevation` callback still works. See [[request-scope]].

14. **`verifySignature(body, ...)` throws `TypeError` on parsed body.** Pass `req.rawBody`, not parsed `req.body`. Register `@fastify/raw-body` before webhook routes. See [[auth]].

15. **Plugins set response headers at `onRequest` or `preSerialization`, never `onSend`.** Async `onSend` races with Fastify's flush path → `ERR_HTTP_HEADERS_SENT`. `isReplyCommitted()` in `src/utils/reply-guards.ts` remains for third-party plugin authors. See [[plugins]].

16. **MCP tools regenerate from resource config.** Changing field rules / permissions / routes changes tool schemas. Run `tests/integrations/mcp/`. See [[mcp]].

17. **MCP `auth: false` → `ctx.user` is `null`, not `"anonymous"`.** Guards still work correctly. See [[mcp]].

18. **`multipartBody()` is a no-op for JSON.** Safe to always add to create/update middlewares.

19. **Don't import values from `@classytic/arc/types`** — it's a type-only barrel. Scope helpers live in `@classytic/arc/scope`; `envelope` + `getUserId(user)` in `@classytic/arc/utils`. The root barrel still re-exports for DX. See [[types]].

20. **Dual-publish trap — modules that subscribe to `arcEvents` must not also publish to it.** Symptom: every subscriber fires twice for the same logical event, audit rows duplicate, downstream cache invalidation runs twice. Root cause is a domain service holding both a publisher and a notification helper that *also* publishes; both call `app.events.publish('order:placed', ...)` against the same bus, so subscribers see the event on each leg.

    Wrong:
    ```ts
    // services/transfer.service.ts — fires twice
    await app.events.publish('transfer:dispatched', payload);
    await notify.transferDispatched(payload); // also publishes internally
    ```

    Right: notification modules subscribe (downstream of arc events), they don't publish. The service emits once.

    Arc ships an opt-in dev-mode duplicate-publish detector — toggled via `arcPlugins: { events: { warnOnDuplicate: true } }` (auto-enabled when `process.env.NODE_ENV !== 'production'`). 5-second LRU on `(eventName, correlationId)`, single warn per collision, no-op in production. See [src/events/eventPlugin.ts](../src/events/eventPlugin.ts) and [[events]].

## Related
- [[rules]]? — see [[identity]] for non-negotiables
- [[security]] — checklist version of the auth-touching gotchas
