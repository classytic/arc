# Wiki Log

Recent decisions only — a **recency signal, not an archive**. This file loads into context, so it stays small: one line per entry (≤150 chars), ~10 entries max, oldest dropped when it grows.

Full history: `git log -- wiki/` · release detail: [changelog/v2.md](../changelog/v2.md) · current contracts: the wiki page itself.

---
- 2026-07-29 — schema-pipeline — Zod request slots convert `io:"input"`; a `.default()` field had been rejecting legal requests with a 400.
- 2026-07-29 — static-assets — `createApp({ assets })`; helmet's `CORP: same-origin` was the real "arc can't serve static" cause.
- 2026-07-31 — modules — transactional boot: phases 2–6 roll back in reverse composition order; `markInitialized` runs BEFORE plugins/bootstrap.
- 2026-07-31 — testing — flake standard: `waitFor(fn,{label})` / `fetchSSE(...)`, never sleep-then-assert. `TIMING_SENSITIVE` is a holding pen.
- 2026-07-31 — modules — `owns` is VERIFIED: an unmet claim now fails boot (it used to delete the route and serve a silent 404).
- 2026-08-02 — modules — disposer contract: `{ defer }` registers teardown at acquisition, LIFO on rollback+shutdown; onClose runs FIRST.
- 2026-08-12 — events — outbox resolves the RAW transport (the `fastify.events` facade published nothing and fails open); no transport is boot-fatal.
- 2026-08-13 — v3 — master plan added: four pillars (transactional truth, declared topology, one policy plane, proven guarantees), phased 0–4, non-goals declared. See v3.md §Master plan.
- 2026-08-13 — core — transactional write envelope: `transactional: true` runs persistence in `retryingTransaction`, verbs get the tx-bound repo, hooks once, boot-fatal without `withTransaction`. changelog/v2.md#2340.
- 2026-08-13 — jobs — `jobsPlugin({ mode })`: producer builds no Worker and owns no repeat reconciliation; worker/both unchanged. changelog/v2.md#2340.
