# Delivery-guarantees matrix

**Summary**: One table for what every async channel actually guarantees — ordering, durability, delivery semantics, retries, dedup burden, backpressure, shutdown behavior, multi-replica behavior.
**Sources**: src/events/, src/utils/sseStream.ts, src/plugins/sse.ts, src/plugins/realtime.ts, src/plugins/schedules.ts, src/integrations/jobs.ts, src/integrations/webhooks.ts.
**Last updated**: 2026-07-17 (added backpressure column — 2.23 audit follow-up).

---

"Events" is not one guarantee in arc — it's seven channels with different contracts. Never assume one channel's semantics on another.

| Channel | Delivery | Durability | Ordering | Retry | Dedup burden | Backpressure | Shutdown | Multi-replica |
|---|---|---|---|---|---|---|---|---|
| **Memory transport** | in-process, fire-and-forget (`failOpen: true`) | none — lost on crash | FIFO | none | n/a | inline — publisher awaits handlers sequentially, no queue to overflow (a slow handler slows the publisher) | drained with process | per-replica only (no fan-out) |
| **Redis pub/sub transport** | at-most-once | none — offline subscriber misses | Redis publish order | none | n/a | **none** — slow subscriber buffers unboundedly in its Redis client | messages in flight lost | every replica receives |
| **Redis Streams transport** | **at-least-once** | persisted in stream; PEL reclaim | preserved per stream | PEL reclaim + jittered backoff, DLQ | **handler MUST be idempotent** | producer-side `XADD MAXLEN ~` cap (default 10k, `maxLen: 0` disables) — consumers falling behind the cap LOSE trimmed entries; consumer reads in bounded, backoff-scaled batches | pending entries reclaimed by survivors | consumer-group: one consumer per message |
| **Outbox** | at-least-once, transactional enqueue | DB row until relayed | relay order (best-effort) | `failurePolicy({ attempts })`, DLQ via `transport.deadLetter()` | consumer-side (event id) | pull-based — relay claims bounded batches (`relayBatch(limit)`); backlog accumulates durably in the DB, never in memory | relay resumes from store | lease/claim — one relayer wins |
| **SSE plugin** | fire-and-forget to connected clients | none — no replay/resume | connection order | client reconnects, missed frames gone | n/a | **fail-fast** — a full socket buffer DESTROYS the connection instead of buffering (slow client is disconnected, not accumulated) | streams closed on shutdown | client sees one replica's stream |
| **Realtime plugin** | change NOTIFIER (not an event store) | none — reconnect = refetch | event-bridge order | client reconnect (`retry:` hint) | client `lastEventId` dedup (`id:` field) | same fail-fast as SSE (shared `sseStream` transport) — slow subscriber loses the connection, reconnect refetches | force-close at token `exp` / `maxConnectionMs` | subscribes to that replica's event bus — use a distributed transport for cross-replica CRUD events |
| **Jobs (`createWorker`, BullMQ)** | at-least-once | Redis-persisted | per-queue, priority-aware | BullMQ attempts/backoff | `jobId` dedup at enqueue; handler idempotent for retries | bounded workers — BullMQ `concurrency` (default 1) + arc-level `maxConcurrent` semaphore; backlog queues durably in Redis | graceful close drains active jobs | competing consumers |
| **Schedules plugin** | tick-based, fail-open per tick (throwing handler logged, loop survives) | none (interval, not cron backfill) | no overlap by construction | next tick | n/a | self-limiting — next tick isn't scheduled until the current run completes (timeout chain); slow handler stretches the interval, never stacks | timeout chain cleared | leader-safe via `LockAdapter` — one replica runs |
| **Webhooks** | **single-attempt** per event, bounded concurrency | delivery log only (in-memory, capped) | per-event, unordered across endpoints | **none** — pair with outbox/Streams upstream for redelivery | receiver dedups on event `meta.id` | bounded delivery concurrency per event (default 5, `concurrency: 1` for sequential) + per-request timeout abort — one slow endpoint can't block the rest | in-flight aborted by timeout | every replica that sees the event dispatches — use a consumer-group transport upstream |

Composition rules:

- **Guaranteed delivery** = outbox (transactional write) → Redis Streams (at-least-once fan-out) → idempotent handler. Any channel without this chain is best-effort.
- **Webhooks are only as reliable as the channel feeding them.** On the memory transport a crash loses the event AND the delivery; behind Streams+consumer-group you get redelivery but must accept duplicate POSTs (receivers dedup on `meta.id`).
- **Realtime/SSE are UX channels, not integration channels.** Anything a downstream system must not miss goes through outbox/Streams, never a socket.
- **Idempotency plugin ≠ event dedup.** It gives exactly-once semantics to inbound HTTP mutations (fingerprint + lock + replay); it does nothing for outbound event consumers.
- **Streams' `MAXLEN` trim is a silent-loss valve.** The default 10k cap keeps Redis memory bounded, but a consumer that falls more than `maxLen` entries behind loses the trimmed ones WITHOUT an error — at-least-once holds only inside the window. Size `maxLen` to worst-case consumer downtime × publish rate, or front it with the outbox (durable backlog) when loss is unacceptable.

See [[events]] for transport configuration, [[plugins]] for sse/realtime/schedules, [[gotchas]] #3 (at-least-once) and the fire-and-forget rule.
