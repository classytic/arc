# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-08-13 — v3 — master plan added: four pillars (transactional truth, declared topology, one policy plane, proven guarantees), phased 0–4, non-goals declared. See v3.md §Master plan.
- 2026-08-13 — core — transactional write envelope: `transactional: true` runs persistence in `retryingTransaction`, verbs get the tx-bound repo, hooks once, boot-fatal without `withTransaction`. changelog/v2.md#2340.
- 2026-08-13 — jobs — `jobsPlugin({ mode })`: producer builds no Worker and owns no repeat reconciliation; worker/both unchanged. changelog/v2.md#2340.
- 2026-08-13 — factory — `createApp({ role })`: api/worker mount no schedule arms, relay mounts only kind:'relay', relay/scheduler+resources boot-fatal. changelog/v2.md#2340.
- 2026-08-13 — factory, delivery-guarantees — runtime capability registry: host-wired memory state now FAILS distributed boot by name (`declareRuntimeCapability`); the wiki checklist is enforcement now. changelog/v2.md#2340.
- 2026-08-13 — events — outbox fencing: token minted IN the claim CAS (`repositoryAsOutboxStore`), stale epoch rejected on ack/fail; relay feature-detects `claimPendingFenced` and threads the token to ack AND fail; LockAdapter + primitives contracts landed same day. changelog/v2.md#2340.
- 2026-08-13 — webhooks — durable delivery = outbox composition: `durable: { store }` enqueues one deterministic row per (event x subscription); `createDurableWebhookModule` relays the signed POST with fencing/DLQ. changelog/v2.md#2340.
- 2026-08-13 — core — capability gates read the DESCRIPTOR: `transactional` asserts `transactions===true` at REGISTRATION (not define time — beforeBoot connects later); read-only repos refuse write routes; retry ownership declared per kit. changelog/v2.md#2340.
- 2026-08-13 — modules, v3 — `plugins` is a SETUP fn arc calls (no encapsulation/prefix): fp() return throws, multi-arg warns. v3 = clean break, NO compat layer: `setup` replaces `plugins`, strictPermissions defaults on.
- 2026-08-14 — idempotency, events, cache — arc closes ONLY stores/transports it built (host-supplied ones outlive the app); self-check cleanup scoped to its own probe (broad sweep failed concurrent boots). changelog/v2.md#2340.
