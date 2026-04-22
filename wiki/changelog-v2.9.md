# Changelog — v2.9

**Summary**: Event contract v2 (additive), durable outbox, multiTenant UPDATE hardening, field-write reject-by-default, elevation audit event.
**Sources**: CHANGELOG.md.
**Last updated**: 2026-04-21.

---

## v2.9.2

- **onSend header-race guard across 5 plugins.** First pass of the fix that became the v2.10.2 rule. See [[plugins]] and [[gotchas]] #15.

## v2.9.1

- **Durable outbox via `RepositoryLike`.** `new EventOutbox({ repository, transport })` — works with mongokit, prismakit, custom repos. Same pattern for `auditPlugin`, `idempotencyPlugin`. See [[adapters]], [[events]].
- Duplicate-key classifier, error handler cross-DB.

## v2.9 (main release)

### Event contract v2 (additive)
`EventMeta` gained optional `schemaVersion`, `causationId`, `partitionKey`. Back-compat — old events work unchanged.
- `createChildEvent(parent, type, payload)` auto-chains causation, inherits `correlationId`, `source`, `idempotencyKey`. **Does not** inherit `aggregate`.
- `DeadLetteredEvent<T>` + optional `transport.deadLetter()` for native-DLQ transports (Kafka/SQS).
See [[events]].

### Outbox (first class)
`EventOutbox.store()` auto-maps `meta.idempotencyKey` → `OutboxWriteOptions.dedupeKey`. `failurePolicy({ event, error, attempts }) => { retryAt?, deadLetter? }` centralises retry/DLQ. `store.getDeadLettered?(limit)` returns `DeadLetteredEvent[]`. `RelayResult.deadLettered` counts per batch.

### Field-write reject-by-default
`BodySanitizer` throws `ForbiddenError` listing denied fields. Pre-2.9 silent-strip behavior requires opt-in: `defineResource({ onFieldWriteDenied: 'strip' })`. See [[core]] and [[gotchas]] #11.

### multiTenant injects on UPDATE
Prior versions only ran injection on CREATE. A member could `PATCH /orders/:id { organizationId: <other-org> }` and move their own doc. v2.9 overwrites body-supplied `organizationId` with caller's scope. Elevated scope still bypasses. See [[presets]] and [[gotchas]] #12.

### Elevation audit event mandatory
Every successful `x-arc-scope: platform` elevation emits `arc.scope.elevated` on `fastify.events`. Apps don't need `onElevation` to audit — subscribe instead. WAL skips `arc.*` to avoid startup timeout. See [[request-scope]].

### Webhook signature stricter
`verifySignature(body, ...)` throws `TypeError` when body isn't string/Buffer. Catches the common misuse of passing `req.body` instead of `req.rawBody`. See [[gotchas]] #14.

### Public API removed
- `createActionRouter` / `buildActionBodySchema` — use `defineResource({ actions })`.
- `ResourceConfig.onRegister` — use `actions` or `hooks`.
- `PluginResourceResult.additionalRoutes` — return `routes: RouteDefinition[]`.

See [[removed]].

## Related
- [[changelog-v2.10]]
- [[events]]
- [[removed]]
