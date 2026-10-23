# Jobs (BullMQ)

```typescript
import { jobsPlugin, defineJob } from '@classytic/arc/integrations/jobs';
```

Peers: `bullmq`, Redis (with `maxmemory-policy noeviction`).

## Define

```typescript
const sendEmail = defineJob({
  name: 'send-email',                       // unique; also the queue name
  handler: async (data: { to: string; subject: string }, meta) => {
    await mailer.send(data.to, data.subject, { signal: meta.signal });
    return { sent: true };
  },
  retries: 3,                               // default 3
  backoff: { type: 'exponential', delay: 1000 },
  timeout: 30000,                           // default 30000; aborts meta.signal
  concurrency: 5,                           // BullMQ concurrency per worker
  maxConcurrent: 2,                         // arc semaphore for a downstream limit
  cancelGraceMs: 30000,                     // max time a timed-out handler holds its slot
  rateLimit: { max: 100, duration: 60000 },
  deadLetterQueue: 'send-email:dead',       // default '<name>-dead'
  repeat: { pattern: '0 9 * * *', tz: 'UTC' },   // cron needs tz; or { every: ms }, plus endDate, limit
});
```

- `meta`: `{ jobId, attemptsMade, timestamp, signal }`. Pass `signal` to fetch and DB calls, or a timed-out handler keeps running and a retry can overlap it. Make handlers idempotent.

## Register

```typescript
await app.register(jobsPlugin, {
  connection: { host: 'localhost', port: 6379 },
  jobs: [sendEmail],
  mode: 'both',                  // 'producer' (queues only, API fleets) | 'worker' | 'both'
  bridgeEvents: true,            // default
  defaults: { retries: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 500 },
});
```

Repeat schedules are reconciled by the side that runs workers.

## Dispatch

```typescript
const { queue, jobId } = await app.jobs.dispatch('send-email', { to: 'a@b.co', subject: 'Hi' }, {
  delay: 5000, priority: 1, jobId: 'dedupe-key', removeOnComplete: true,
});
const status = await app.jobs.getStatus(queue, jobId);   // JobStatus | null; ids are queue-local
const stats = await app.jobs.getStats();                 // { [queue]: { waiting, active, completed, failed, delayed } }
```

`app.jobs` also has `getQueue(name)` and `close()`.

## Management routes (off by default)

```typescript
import { requirePlatformRole } from '@classytic/arc/permissions';

managementRoutes: {
  operatorPermission: requirePlatformRole('platform-ops'),  // required, platform-only
  exposeResult: false,          // default: hide returnValue
  exposeFailureReason: false,   // default: hide failedReason
}
```

Mounts `GET <prefix>/stats` (prefix default `/jobs`) and `GET <prefix>/:queue/:id/status`. Both are global (a job carries no tenant), so org-role gates are refused at boot; `allowUnverifiedOperatorPermission: true` accepts a custom check you verified.

## Event bridge

With `bridgeEvents`, the bus gets `job.<name>.completed` (`{ jobId, data, result }`), `job.<name>.failed` (`{ jobId, data, error, attemptsMade }`), `job.<name>.stalled` (`{ jobId }`). Publishing is best effort and never fails the worker.
