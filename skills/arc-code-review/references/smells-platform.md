# Smells: jobs, presets, MCP, lifecycle, module packages

## P1. Hand-rolled recurring jobs [high]

Grep: `setInterval\s*\(`, `node-cron`, `cron\.schedule`, `new CronJob`, `acquireLock`, home-grown "leader lock" or "job registry" files.
Why: overlap prevention, multi-replica leases, shutdown cleanup and failure counters get re-grown per host and at least one is wrong (stacked runs, timers holding the process open, no failover after a crashed leader).
Fix: `schedulesPlugin` from `@classytic/arc/plugins`: no overlap by construction, optional `lock` (a repo-core `LockAdapter`, for example `createMongoLockAdapter` from `@classytic/mongokit/lock`), `jitterMs`, `runOnStart`, `leaseMs`, `fastify.getScheduleStats()`, clean drain on close. `createApp({ arcPlugins: { schedules: { lock } } })` configures the same runner for module `scheduledJobs`.

## P2. Hand-rolled once-a-day gate [high]

Grep: marker rows or flags like `lastRunDate`, `ranToday`, `daily_job_runs`, `toISOString().slice(0, 10)` compared in a timer, `new Date().getHours() ===`.
Why: UTC date strings skip or double a day around DST and zone offsets; two replicas both claim the slot; a crash mid-run leaves a stuck marker.
Fix: a `daily` block on the schedule. The decision is a civil date in the named IANA zone; the host supplies a `DailyLedger` whose `claimDay` is atomic across replicas (unique key).

```ts
import { createMemoryDailyLedger, schedulesPlugin, type DailyLedger } from "@classytic/arc/plugins";

await app.register(schedulesPlugin, {
  schedules: [{
    name: "daily-digest",
    every: 60_000, // poll interval, keep well under an hour
    daily: { hour: 8, minute: 30, zone: "Asia/Dhaka", ledger }, // createMemoryDailyLedger() in tests
    handler: async (f, ctx) => sendDigest(f, ctx?.day),
  }],
});
```

A throwing run releases the claim and retries on the next poll. `catchUpWindowMs` skips a day the process slept through; `staleAfterMs` re-grants a claim a crashed run never completed. `createDailyGate` serves hosts that tick elsewhere.

## P3. Hand-wired queue [medium]

Grep: `new Queue\(`, `new Worker\(` from `bullmq` in app code.
Fix: `jobsPlugin` and `defineJob` from `@classytic/arc/integrations/jobs`. Real cron expressions and durable retries are a legitimate BullMQ use; do not flag them. See the arc skill, references on jobs.

## P4. Reimplemented presets [medium]

Fingerprints in handler names and routes:
- softDelete: `getDeleted`, `restore`, `GET /deleted`, `POST /:id/restore` (preset adds the routes; the repository filters with `softDelete: true`).
- slugLookup: `getBySlug`, `GET /slug/:slug`.
- tree: `getChildren`, `getTree`, `parentId` plumbing.
- bulk: `bulkCreate`, `bulkUpdate`, `bulkDelete`, `POST /bulk`.
- multiTenant: every query appended with `organizationId: ...`.
- ownedByUser: every query appended with the caller's id.
- audited: a write to an audit collection on each mutation.
- filesUpload, search: ad hoc upload and `/search` routes.

Fix:

```ts
presets: [
  "softDelete",
  "bulk",
  { name: "slugLookup", slugField: "slug" },
  { name: "multiTenant", tenantField: "organizationId" },
  { name: "ownedByUser", ownerField: "authorId" },
],
```

Several tenant levels (branch, project): `multiTenantPreset({ tenantFields: [...] })` from `@classytic/arc/presets`; pass `tenantField` or `tenantFields`, never both.

## P5. Hand-written MCP tools [medium]

Grep: `CallToolRequestSchema`, `setRequestHandler\(\s*Call`, `inputSchema\s*:\s*\{\s*type\s*:\s*['"]object`, files named `tools.ts` or `mcp.ts` defining `name`, `description`, `handler`.
Fix: `mcpPlugin` from `@classytic/arc/mcp` with `resources: [...]`; CRUD, custom routes and actions become tools with the same permissions and field rules. Opt a resource out with `mcp: false`. Domain tools use `defineTool` and `buildMcpToolsFromBridges`.

## P6. Async engine at import time, wrong boot slot [high]

Grep: top-level `await` in `*.resource.ts`; `await ensure\w+Engine\(`; a composition root that connects the DB and then dynamic-imports the app.
Why: resource files evaluate before `bootstrap`, so the engine or connection is not ready.
Fix: connect the DB in `createApp({ beforeBoot })`, init engines in `bootstrap`, and pass `resources` as a factory so it runs after bootstrap. `loadResources(import.meta.url, { context })` hands each `*.resource.ts` a context.

```ts
createApp({
  beforeBoot: async () => connectDatabase(),
  bootstrap: [async () => { await ensureCatalogEngine(); }],
  resources: async () => buildResources(await getCatalogEngine()),
});
```

## P7. Casts on engine bags in module packages [high]

Grep: `as never`, `as unknown as` around `defineResource`, adapter construction or config spreads.
Why: each cast hides a real type; wrong repos pair with wrong models and spread merges clobber host arrays.
Fix: type the engine port with the kernel's own bags and assemble with `mergeResourceConfig` and `ResourceSeams` from `@classytic/arc`. See the arc-module-publishing skill.

## P8. Repeated CRUD gates [low]

Grep: the same `view` or `manage` check on all five permission keys.
Fix: `permissionMatrix({ read, write, delete? })` from `@classytic/arc/permissions`.
