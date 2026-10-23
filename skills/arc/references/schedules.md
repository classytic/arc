# Scheduled jobs: intervals and daily runs

`schedulesPlugin` (`@classytic/arc/plugins`) runs in-process recurring jobs. Module-contributed `scheduledJobs` use the same plugin, configured through `arcPlugins.schedules`. For durable, Redis-backed jobs use `@classytic/arc/integrations/jobs` (BullMQ).

## Interval job (module)

```typescript
import { defineModule } from '@classytic/arc/factory';

defineModule({
  name: 'billing',
  scheduledJobs: [{
    name: 'billing.sweep',
    every: 60_000,                 // ms between the END of one run and the next tick
    jitterMs: 10_000,              // spread first tick (ignored with runOnStart)
    handler: async (fastify) => { await sweep(); },
  }],
});

createApp({ arcPlugins: { schedules: { lock, singleReplica: false } }, modules: [billing] });
```

| Rule | Detail |
|---|---|
| No overlap | next tick is scheduled after the current run settles |
| Fail-open | a throwing handler is logged and counted, the loop continues |
| Multi-replica | pass `lock` (any `LockAdapter` from `@classytic/repo-core/lock`; `createMemoryLockAdapter()` for tests): winner runs, others skip. Lease is held ~`every` |
| Distributed runtime | a schedule with neither `lock` nor `singleReplica: true` fails boot |
| Kill switch | `arcPlugins.schedules: { enabled: false }` arms nothing |
| Stats | `fastify.getScheduleStats()`: `runs`, `failures`, `skippedByLock`, `lastRunAt`, `lastError` |
| Roles | `createApp({ role })`: `api`/`worker` arm nothing, `relay` arms `kind: 'relay'`, `scheduler` arms all |

Interval only: arc has no cron parser. Wall-clock needs use `daily`.

## Daily: once per local calendar day

`every` becomes the poll interval (use 1 to 15 minutes). The job runs once per civil day at or after `hour:minute` in an IANA `zone`.

```typescript
import { createMemoryDailyLedger, type DailyLedger } from '@classytic/arc/plugins';

scheduledJobs: [{
  name: 'competency.daily-sweep',
  every: 15 * 60_000,
  daily: {
    hour: 2, minute: 0, zone: 'Asia/Dhaka',
    ledger,                        // host DailyLedger
    catchUpWindowMs: 6 * 3_600_000, // optional: skip a run later than this after hh:mm
    staleAfterMs: 30 * 60_000,      // optional: re-grant an uncompleted claim (crash mid-run)
    clock: { now: () => new Date() }, // optional: injectable for tests
  },
  handler: async (fastify, ctx) => { await sweep(ctx?.day); },   // ctx.day = 'YYYY-MM-DD'
}]
```

Semantics:
- The day is `civilDateOf(now, zone)` (`@classytic/primitives/timezone`), never UTC and never the server zone. DST-exact: a time inside a spring-forward gap fires when the clock jumps past it; a repeated time fires on its first occurrence; the ledger blocks the second.
- Restart safe: a new process reads the ledger and sees the day claimed. Multi-replica safe: the schedule lease picks one poller, the ledger claim is the idempotency guard.
- A throwing handler releases the claim; the next poll retries. A crash leaves the claim (at-most-once) unless `staleAfterMs` is set.
- `getScheduleStats()` adds `lastDay` and `skippedByGate` for daily schedules; `runs` counts executions, not declined polls.
- Boot validates `hour` 0-23, `minute` 0-59 and the zone; the error names the schedule.

## The ledger contract (host implements)

```typescript
interface DailyLedger {
  claimDay(key: string, civilDate: string, info: { now: Date; staleAfterMs?: number }): Promise<boolean>; // atomic, one winner
  completeDay?(key: string, civilDate: string, result?: Record<string, unknown>): Promise<void>;
  releaseDay(key: string, civilDate: string): Promise<void>;
}
```

`key` is the schedule name. Back it with a unique `(key, civilDate)` row (insert; duplicate-key means lost). `claimDay` may re-grant a claim only when it was never completed and is older than `info.staleAfterMs`. `createMemoryDailyLedger()` is the test implementation (`.claims()` for assertions).

`createDailyGate({ key, ledger, zone, hour, minute?, catchUpWindowMs?, staleAfterMs?, clock? })` is the same gate for a host that ticks elsewhere: `await gate.run(async (day) => ...)` returns `{ ran: true, day, result }` or `{ ran: false, reason: 'too-early' | 'outside-window' | 'already-claimed' }`.

## Test it

Inject a fixed `clock`, a memory ledger and `every: 20`; assert the handler ran once across two apps sharing the ledger and lock. Use `waitFor` from `@classytic/arc/testing`, never a fixed sleep.
