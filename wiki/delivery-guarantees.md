# Delivery-guarantees matrix

**Summary**: One table for what every async channel actually guarantees — ordering, durability, delivery semantics, retries, dedup burden, backpressure, shutdown behavior, multi-replica behavior.
**Sources**: src/events/, src/utils/sseStream.ts, src/plugins/sse.ts, src/plugins/realtime.ts, src/plugins/schedules.ts, src/integrations/jobs.ts, src/integrations/webhooks.ts.
**Last updated**: 2026-08-23 (outbox joins the ambient transaction by default; `eventStrategy` name corrected to `emitEvents`).

---

"Events" is not one guarantee in arc — it's several channels with different contracts. Never assume one channel's semantics on another.

| Channel | Delivery | Durability | Ordering | Retry | Dedup burden | Backpressure | Shutdown | Multi-replica |
|---|---|---|---|---|---|---|---|---|
| **Memory transport** | in-process, fire-and-forget (`failOpen: true`) | none — lost on crash | FIFO | none | n/a | inline — publisher awaits handlers sequentially, no queue to overflow (a slow handler slows the publisher) | drained with process | per-replica only (no fan-out) |
| **Redis pub/sub transport** | at-most-once | none — offline subscriber misses | Redis publish order | none | n/a | **none** — slow subscriber buffers unboundedly in its Redis client | messages in flight lost | every replica receives |
| **Redis Streams transport** | **at-least-once** | persisted in stream; PEL reclaim | preserved per stream (default `processingConcurrency: 1`; raising it lets a batch's entries complete OUT of order — only for order-independent handlers) | PEL reclaim + jittered backoff, DLQ | **handler MUST be idempotent** | producer-side `XADD MAXLEN ~` cap (default 10k, `maxLen: 0` disables) — consumers falling behind the cap LOSE trimmed entries; consumer reads in bounded, backoff-scaled batches | pending entries reclaimed by survivors | consumer-group: one consumer per message |
| **Outbox** | at-least-once, transactional enqueue | DB row until relayed | relay order (best-effort) | `failurePolicy({ attempts })`, DLQ via `transport.deadLetter()` | consumer-side (event id) | pull-based — relay claims bounded batches (`relayBatch(limit)`); backlog accumulates durably in the DB, never in memory | relay resumes from store | lease/claim — one relayer wins; fencing stores (`repositoryAsOutboxStore`, memory) mint a token in the claim CAS and reject a stale ex-holder's ack/fail after takeover (2.33, feature-detected) |
| **SSE plugin** | fire-and-forget to connected clients | none — no replay/resume | connection order | client reconnects, missed frames gone | n/a | **fail-fast** — a full socket buffer DESTROYS the connection instead of buffering (slow client is disconnected, not accumulated) | streams closed on shutdown | client sees one replica's stream |
| **Realtime plugin** | change NOTIFIER (not an event store) | none — reconnect = refetch | event-bridge order | client reconnect (`retry:` hint) | client `lastEventId` dedup (`id:` field) | same fail-fast as SSE (shared `sseStream` transport) — slow subscriber loses the connection, reconnect refetches | force-close at token `exp` / `maxConnectionMs` | subscribes to that replica's event bus — use a distributed transport for cross-replica CRUD events |
| **Jobs (`createWorker`, BullMQ)** | at-least-once | Redis-persisted | per-queue, priority-aware | BullMQ attempts/backoff | `jobId` dedup at enqueue; handler idempotent for retries | bounded workers — BullMQ `concurrency` (default 1) + arc-level `maxConcurrent` semaphore; backlog queues durably in Redis | graceful close drains active jobs | competing consumers |
| **Schedules plugin** | tick-based, fail-open per tick (throwing handler logged, loop survives) | none (interval, not cron backfill) | no overlap by construction | next tick | n/a | self-limiting — next tick isn't scheduled until the current run completes (timeout chain); slow handler stretches the interval, never stacks | timeout chain cleared | leader-safe via `LockAdapter` — one replica runs; lease auto-renews at `leaseMs/2` while the handler runs so long runs can't be overlapped by a replica after lease expiry |
| **Webhooks (inline)** | single-attempt by default; opt-in in-process retry (`retry: { attempts, backoffMs }` — transient failures only: network/timeout/429/5xx) | delivery log only (in-memory, capped) | per-event, unordered across endpoints | in-process exponential backoff when configured, lost on crash/deploy — use durable mode (row below) for redelivery | receiver dedups on event `meta.id` (constant across retries) | bounded delivery concurrency per event (default 5, `concurrency: 1` for sequential) + per-request timeout abort — one slow endpoint can't block the rest | in-flight aborted by timeout; queued retries dropped | every replica that sees the event dispatches — use a consumer-group transport upstream |
| **Webhooks (durable, 2.33)** | at-least-once — one outbox row per (event × subscription); enqueue is exactly-once per pair (deterministic id doubles as `dedupeKey`) | DB row until delivered | relay order (best-effort), unordered across endpoints | relay failure policy: transient (network/timeout/429/5xx) retries on exponential backoff (default 8 attempts, 15min cap), permanent (4xx / 3xx-under-manual / policy rejection / malformed) dead-letters on the FIRST attempt | receiver dedups on `meta.id` (the ORIGINAL event's, constant across retries) | pull-based, same as outbox — backlog accumulates durably in the DB | relay resumes from store; survives crash and deploy | lease/claim + fencing — one relayer wins; `role: 'api'` enqueues, `role: 'relay'` delivers |

Composition rules:

- **Guaranteed delivery** = outbox (transactional write) → Redis Streams (at-least-once fan-out) → idempotent handler. Any channel without this chain is best-effort.
- **Webhooks are only as reliable as the channel feeding them.** On the memory transport a crash loses the event AND the delivery; behind Streams+consumer-group you get redelivery but must accept duplicate POSTs (receivers dedup on `meta.id`). Durable mode (`webhookPlugin({ durable: { store } })` + `createDurableWebhookModule`) fixes the DELIVERY half only — the row survives, the upstream event still needs its own durable path.
- **Realtime/SSE are UX channels, not integration channels.** Anything a downstream system must not miss goes through outbox/Streams, never a socket.
- **Idempotency plugin ≠ event dedup.** It gives exactly-once semantics to inbound HTTP mutations (fingerprint + lock + replay); it does nothing for outbound event consumers.
- **Streams' `MAXLEN` trim is a silent-loss valve.** The default 10k cap keeps Redis memory bounded, but a consumer that falls more than `maxLen` entries behind loses the trimmed ones WITHOUT an error — at-least-once holds only inside the window. Size `maxLen` to worst-case consumer downtime × publish rate, or front it with the outbox (durable backlog) when loss is unacceptable.
- **Automatic CRUD events ≠ transactional outbox events.** `emitEvents` (arc's automatic CRUD after-hook) publishes AFTER the repository write, outside any transaction, fire-and-forget (`failOpen: true`) — an integration convenience: a crash or transport outage between write and publish loses the event with the write already committed. A durable business guarantee requires the domain command to write the outbox row IN the same transaction/session as the business data (`outbox.store(event, { session })`); the relay publishes later. Do not read the auto-emission as guaranteed delivery — the two paths answer different questions.
- **Relay identity is per RELAY INSTANCE.** `createOutboxModule`'s default `consumerId` is `<module-name>:<hostname>:<pid>:<random>` (2.33), minted at bootstrap and stable across that relay's ticks. A lease identifies an independently executing claimant, and two co-resident modules have two schedule arms — nothing stops both pointing at one store. The old shared literal made every replica AND every module the same logical owner, pinning the stale-owner check open. If you set it explicitly, keep it distinct per relay, not merely per deployment.
- **The outbox relay does not publish through `fastify.events`.** That decorator is a request-facing facade: different signature (`publish(type, payload, meta?)`) and FAIL-OPEN by design, so a swallowed publish error would acknowledge a row that never arrived. The relay resolves the raw `EventTransport` instead (`ARC_EVENT_TRANSPORT`), and a module that cannot resolve one refuses to boot rather than ticking forever against a growing store. The split is deliberate: **the HTTP-facing facade may fail open; the relay must observe failure.**
- **Relay failures are never console-wired by hosts.** With no explicit `onError`, the module reports structured context through `fastify.log.error`; supply `onError` only to replace that sink with metrics or alerting.

## Single-node deployment (no Redis)

One process is a legitimate production topology, not a compromise: with no other instances to broadcast to, the memory transport is exactly sufficient. Declare it — `createApp({ runtime: 'memory' })` (explicitly, not by omission) or `eventPlugin, { singleProcess: true }` — and the boot-time memory-transport warn becomes an info line; undeclared memory stays a warning because it is indistinguishable from a multi-replica app that forgot Redis.

Durability without Redis: **repository-backed outbox + memory transport**. Events commit to YOUR database (`createOutboxModule` + `repositoryAsOutboxStore`), the in-process relay publishes them to in-process subscribers, and a crash between write and publish replays from the DB on restart. Scale out later by swapping the transport (Redis Streams) and removing the declaration; handlers are transport-independent and unchanged.

**Read the guarantee precisely — it has two halves, and only one is on by default:**

| | default (`onHandlerError: 'log'`) | `onHandlerError: 'throw'` |
|---|---|---|
| Crash BEFORE publish | replayed from the DB | replayed from the DB |
| Handler THROWS | row acknowledged, never retried | row left unacknowledged → `failurePolicy` retries / dead-letters |
| Guarantee | at-least-once **publication** | at-least-once **processing** |

The default is the fire-and-forget bus contract and is deliberate: one broken analytics subscriber must not fail a publisher's request. But with THIS transport `publish()` *is* the handling — subscribers run synchronously, in-process — so a swallowed handler error reads to the relay as a successful delivery. Measured: handler throws once, `relayBatch()` reports `relayed: 1, publishFailed: 0`, next tick finds nothing. Pass `new MemoryEventTransport({ onHandlerError: 'throw' })` when the outbox is meant to cover processing, and make handlers idempotent — a retry redelivers to ALL matching handlers, since the transport has no per-handler cursor.

No such ambiguity exists on a broker: there, `publish()` means "durably handed off", acknowledging is correct, and redelivery is the consumer group's job.

## Distributed deployment checklist

`runtime: 'distributed'` validates only what `createApp` can see: `stores.events` (always), `stores.cache`/`stores.queryCache` (when those plugins are on), `stores.idempotency` (warn), and schedules-without-lock (warn). Everything below is wired in `plugins()`/`bootstrap[]` where the constructor-time guard can't inspect it. Since 2.33 this list is ENFORCED: subsystems (and hosts) declare via `declareRuntimeCapability`, and the end-of-boot audit fails a distributed app on undeclared-shared memory state. The list stays as the map of what to check:

- **Webhook store + dispatch** — subscriptions load into a per-replica snapshot at boot (a `register()` on one replica isn't visible to others until restart), and every replica that sees an event dispatches. Feed webhooks from a consumer-group transport (Streams) so one replica owns each event, or use durable mode, where the lease makes one relayer own each delivery (the subscription store must still be shared — the relaying process resolves URL + secret through `fastify.webhooks`).
- **Audit / usage stores** — memory-backed stores are replica-local; supply DB/Redis-backed repositories.
- **Response cache** (`caching` plugin) — always per-process by design (it's a hot-path micro-cache); correctness comes from short TTLs, not shared state. Know that replicas can serve briefly-divergent responses.
- **Realtime / SSE** — each client sees ONE replica's event bus; cross-replica CRUD events require a distributed transport (see matrix).
- **Outbox relay** — lease-based, safe by construction, but ONE deployment must actually run the relay (worker or leader), not zero and not "whichever".
- **Rate limiting** — validated separately at `registerSecurity`; needs a shared store for global limits.
- **Migrations** — run from a deploy job with `MigrationRunner({ lock })`, never from every replica's startup.
- **Query-cache version bumps** — use a store with `increment` (Redis) so concurrent invalidations from different replicas can't lose writes.

See [[events]] for transport configuration, [[plugins]] for sse/realtime/schedules, [[gotchas]] #3 (at-least-once) and the fire-and-forget rule.
