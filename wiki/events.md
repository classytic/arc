# Events

**Summary**: `EventPlugin` publishes domain events via pluggable transports. Publishing is fire-and-forget by default. Use the outbox for guaranteed delivery.
**Sources**: src/events/.
**Last updated**: 2026-10-10 (stable subscriber progress and transaction-aware inbox completion).

---

## Shape

```ts
import { EventMeta, DomainEvent, createEvent, createChildEvent } from '@classytic/primitives/events';

// EventMeta
{
  id, timestamp,
  schemaVersion?, correlationId?, causationId?, partitionKey?,
  source?, idempotencyKey?,
  resource?, resourceId?, userId?, organizationId?,
  aggregate?: { type: string; id: string },   // NOT inherited by createChildEvent
}
```

- `@classytic/primitives/events` is the source of truth for event types (`EventMeta`, `DomainEvent`, `EventHandler`, `EventLogger`, `EventTransport`, `DeadLetteredEvent`, `PublishManyResult`, `createEvent`, `createChildEvent`, `matchEventPattern`). Arc re-exports the runtime `MemoryEventTransport` only.
- Domain packages narrow `aggregate.type` to a closed union via interface extension.
- `createChildEvent(parent, type, payload)` auto-chains causation + inherits `correlation` and `source`. `aggregate` and occurrence-specific `idempotencyKey` are **not** inherited; set the child's key explicitly when needed.

## Transports

| Transport | Guarantee | Use |
|---|---|---|
| memory | in-process | dev/test, or a DECLARED single-node deployment (`runtime: 'memory'` / `singleProcess: true` — see [[delivery-guarantees]]) |
| Redis pub/sub | at-most-once | low-latency, lossy OK |
| Redis Streams | at-least-once | durable; consumer groups track offsets |

Redis Streams does **not** dedupe — handlers must be idempotent. See [[gotchas]] #3.

Partial failures record completed subscriber identities in Redis. Use `withSubscriberId('ledger-post', handler)` with an explicit deployment-stable id for anonymous or same-named subscribers. Duplicate implicit pattern/name identities refuse registration; registration indexes are never identities. Module subscribers receive identities from their module and declared handler name (or a unique pattern set). Changing identities during a rollout can replay previously completed handlers, so effects still need idempotency.

`withInbox(name, handler, { store })` records completion per `(name, event id)` and automatically supplies a stable subscriber identity. Its completion follows the handler: a crash or store error can repeat an already applied effect. Use `context.eventId` to dedupe nontransactional or external effects. For DB effects, pass `transaction: work => repository.withTransaction(session => work(session))` and use `context.session` for every handler write; the claim store must honor that session on the same database connection. Claim, effect and completion then commit or roll back together. Size `leaseMs` above the handler's worst-case runtime; this wrapper does not renew leases.

`DeadLetteredEvent<T>` + optional `transport.deadLetter()` added for native-DLQ transports (Kafka/SQS).

## Publishing is fire-and-forget (`failOpen: true`)

If publishing fails, the HTTP request still succeeds. For guaranteed delivery, use the outbox. Don't change the default — it protects user-facing latency. See [[gotchas]] #7.

## Dual-publish dev-warn

`eventPlugin` keeps a 5-second LRU keyed on `(eventType, correlationId)` and emits an `arcLog("events").warn` the second time one request publishes the same event inside that window. The trap it catches: a domain service holding BOTH a publisher AND a notification helper that publishes to the same bus internally, so every subscriber fires twice for one logical event.

`warnOnDuplicate` — `undefined` (default) enables it outside production, `true` enables it everywhere (one Map lookup per publish), `false` disables it. **Arc still publishes** on detection: this is a diagnostic, not a guard. Pick one publish path rather than relying on it.

## Outbox (v2.9+)

Transactional enqueue with at-least-once relay; consumer effects need idempotency or atomic inbox completion.

```ts
new EventOutbox({ repository, transport });  // repository is any RepositoryLike — see [[adapters]]
```

**Contract vs runtime split (2.24):** the CONTRACT (`OutboxStore`, option types, `OutboxOwnershipError`, `InvalidOutboxEventError`) is owned by `@classytic/primitives/outbox` (>=0.13) — arc does NOT re-export it; import from primitives (same rule as the event types since 2.12). Arc owns the RUNTIME: `EventOutbox`, `RelayResult`, `MemoryOutboxStore`, `repositoryAsOutboxStore`, `exponentialBackoff`. Domain packages implement stores against primitives alone (never peer-dep arc); one class identity makes `instanceof OutboxOwnershipError` work across the boundary.

- `store()` auto-maps `meta.idempotencyKey` → `OutboxWriteOptions.dedupeKey`.
- `failurePolicy({ event, error, attempts }) => { retryAt?, deadLetter? }` centralises retry/DLQ.
- `store.getDeadLettered?(limit)` returns `DeadLetteredEvent[]`.
- `RelayResult.deadLettered` counts per batch.

v2.10.3 fixed a plugin onSend race + idempotency lock-leak (closures captured stale reply state). See [[plugins]] and [[gotchas]] #15.

## WAL skips `arc.*` internal events

Prevents startup timeout with durable stores. See [[gotchas]] #7-8.

## Related
- [[adapters]] — outbox consumes `RepositoryLike`
- [[hooks]] — after hooks typically publish events
- [[plugins]] — idempotency plugin pairs with outbox
