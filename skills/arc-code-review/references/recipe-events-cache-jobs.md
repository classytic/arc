# Recipe: events, cache, schedules, idempotency, MCP

## Events

Before: `await eventBus.emit("order.created", ...)` in POST, forgotten in PATCH.
After: nothing. Arc emits `order.created`, `order.updated`, `order.deleted` after every CRUD write (`arcPlugins.emitEvents` defaults on). Subscribe through module `eventHandlers` or `fastify.events`. Types: `@classytic/primitives/events`. At-least-once delivery: `EventOutbox` and `createOutboxModule` from `@classytic/arc/events` with an outbox store (`repositoryAsOutboxStore`); verify a store with `runOutboxStoreContract` from `@classytic/arc/testing/outbox`. Use `RedisStreamTransport` from `@classytic/arc/events/redis-stream` for a durable transport with consumer groups.

## Cache

Before: `redis.get("products-list")`, `redis.del("products-list")` after writes.
After:

```ts
const app = await createApp({
  arcPlugins: { queryCache: true },
  stores: { queryCache: new RedisCacheStore({ client }) },
  resources: [productResource],
});

defineResource({
  name: "product",
  adapter,
  cache: { staleTime: 30, gcTime: 300, tags: ["catalog"], invalidateOn: { "category.*": ["catalog"] } },
});
```

Writes bump the resource version; the next read sees fresh data. `RedisCacheStore` is from `@classytic/arc/cache`; omit `stores.queryCache` for the in-memory default.

## Recurring jobs

Interval job with multi-replica safety:

```ts
import { schedulesPlugin } from "@classytic/arc/plugins";
import { createMongoLockAdapter } from "@classytic/mongokit/lock";

await app.register(schedulesPlugin, {
  lock: createMongoLockAdapter({ connection }),
  schedules: [{ name: "outbox-sweep", every: 30_000, jitterMs: 5_000, handler: async (f) => sweep(f) }],
});
```

Once per local day (replaces timers plus marker rows):

```ts
schedules: [{
  name: "daily-digest",
  every: 60_000,
  daily: { hour: 8, minute: 30, zone: "Asia/Dhaka", ledger: dailyLedger },
  handler: async (f, ctx) => sendDigest(f, ctx?.day), // ctx.day is YYYY-MM-DD in that zone
}],
```

The host implements `DailyLedger` once, in a repository file. `claimDay` must be atomic across replicas: a unique index on `(key, civilDate)`, losing insert returns `false`.

```ts
import type { DailyLedger } from "@classytic/arc/plugins";
import { isDuplicateKeyError } from "@classytic/mongokit";

export const dailyLedger: DailyLedger = {
  async claimDay(key, civilDate) {
    try {
      await LedgerModel.create({ key, civilDate });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  },
  async releaseDay(key, civilDate) {
    await LedgerModel.deleteOne({ key, civilDate });
  },
};
```

Tests use `createMemoryDailyLedger()` and an injected `clock`. Optional knobs: `catchUpWindowMs`, `staleAfterMs`, `completeDay`. A module ships its jobs as `scheduledJobs`; locking is configured in `arcPlugins.schedules`. Calendar cron expressions and durable retries stay in `jobsPlugin` from `@classytic/arc/integrations/jobs`.

## Idempotency

Before: `Idempotency.findOne({ key })` inside the handler.
After:

```ts
import { idempotencyPlugin } from "@classytic/arc/idempotency";

await app.register(idempotencyPlugin, { repository: idempotencyRepo, ttlMs: 24 * 3600_000 });
defineResource({ name: "payment", adapter, idempotency: { required: ["create"] } });
```

A keyless create then answers 400 `arc.idempotency_key_required`, a keyed retry replays the stored response. The repository needs `getOne`, `deleteMany`, `findOneAndUpdate`; mongokit's `createIdempotencyStore` (`@classytic/mongokit/idempotency`) provides a ready store.

## MCP

Before: 200 lines of `setRequestHandler(CallToolRequestSchema, ...)`.
After:

```ts
import { mcpPlugin } from "@classytic/arc/mcp";

await app.register(mcpPlugin, { resources: [productResource, orderResource], auth: false });
```

CRUD, custom routes and actions become tools; permissions and field rules carry over. `mcp: false` on a resource opts it out.

## Tests

Before: hand-started `MongoMemoryServer`, hand-built auth headers.
After: `createTestApp` and `expectArc` from `@classytic/arc/testing`; `createHttpTestHarness(resource)` generates CRUD, permission and validation tests; module packages use `bootModuleApp`.

```ts
const ctx = await createTestApp({ resources: [productResource], authMode: "jwt", connectMongoose: true });
```
