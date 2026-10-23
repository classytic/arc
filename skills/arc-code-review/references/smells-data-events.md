# Smells: data layer, events, cache, audit

## D1. Driver imports outside model, repository, adapter files [high]

Grep: `^import .*\b(mongoose|@prisma/client|drizzle-orm)\b` in `src/**`, then drop `*.model.ts`, `*.repository.ts`, `*.adapter.ts` and `src/db/**`.
Why: services, hooks and routes pull a database driver; tests need a live DB; swapping stores becomes a rewrite.
Fix: services take a repository interface (`RepositoryLike<TDoc>` from `@classytic/repo-core/adapter`); mongoose stays in model, repository and adapter files. Transactions go through `repo.withTransaction(...)`.

## D2. Mongoose models with hand-rolled repository classes [high]

Detect: `package.json` has `mongoose` but not `@classytic/mongokit`; `class \w+Repository`; `schema\.(pre|post)\(`; `skip\(.*page`; `countDocuments\(`; `startSession\(`; `runValidators`.
Why: each class re-implements tenant filters, soft delete, timestamps, pagination, transactions and uniqueness checks, and drifts.
Fix: mongokit `createRepository` per model, wired into arc with `createMongooseAdapter(Model, repo)`. See mongokit-repositories.md and the mongokit skill.

## D3. Hand-rolled aggregation routes [high]

Grep: `Model\.aggregate\(\[`, `\$group\b`, `\$match\b` inside route or resource files.
Why: loses per-aggregation permissions, OpenAPI, MCP tool, cache and tag invalidation, `requireFilters`, `requireDateRange` and `maxGroups` guards, and tenant scoping without ObjectId casts. Tenant type coercion is the kit's job; never inject the tenant key into the filter from host code.
Fix:

```ts
aggregations: {
  byMethod: defineAggregation({
    groupBy: "method",
    measures: { total: "sum:amount", count: "count" },
    sort: { total: -1 },
    cache: { staleTime: 60, swr: true, tags: ["revenue"] },
    permissions: requireRoles(["admin", "finance"]),
  }),
},
```

Registers `GET /<prefix>/aggregations/byMethod`. A backend without `repo.aggregate` declares a `materialized` hook and keeps the same envelope, permission gate and cache contract.

## D4. Manual event emission [high]

Grep: `(eventBus|emitter|events|pubsub)\.(emit|publish)\(['"]\w+\.(created|updated|deleted)`.
Why: a missed emit on PATCH breaks search indexing, cache invalidation and audit consumers, and tests rarely notice.
Fix: arc emits `<resource>.created`, `.updated`, `.deleted` for every CRUD write (`arcPlugins.emitEvents` defaults on). Keep custom domain events in actions or module `eventHandlers`. Guaranteed delivery uses the outbox (`EventOutbox`, `createOutboxModule` from `@classytic/arc/events`). Event types come from `@classytic/primitives/events`.

## D5. Manual cache and invalidation [medium]

Grep: `(redis|cache)\.(get|set|setex|del|invalidate)\(['"]\w+[-:_]`, hand-built key strings.
Fix: enable the query cache and declare policy per resource.

```ts
createApp({ arcPlugins: { queryCache: true }, stores: { queryCache: new RedisCacheStore({ client }) }, resources });
defineResource({ name: "product", adapter, cache: { staleTime: 30, gcTime: 300, tags: ["catalog"], invalidateOn: { "category.*": ["catalog"] } } });
```

`RedisCacheStore` is from `@classytic/arc/cache`; the default store is memory. Responses carry `x-cache: HIT | STALE | MISS`. Do not suggest cache tags to an app that left `queryCache` off; say to enable it first.

## D6. Manual idempotency [high]

Grep: `idempotency-key` header reads, custom lookup tables, retry tables.
Fix: `idempotencyPlugin` from `@classytic/arc/idempotency` with `repository` (needs `getOne`, `deleteMany`, `findOneAndUpdate`) or a `store`, plus `ttlMs`. A write that must never run twice sets `idempotency: { required: ["create"] }` on the resource, or `idempotency: { required: true }` on an action.

## D7. Manual audit trail [medium]

Grep: every mutation handler appending to `audit_logs`, `history`, `events` collections.
Fix: `auditPlugin` from `@classytic/arc/audit`, then `audit: true` or `audit: { operations: ["delete"] }` per resource, or `presets: ["audited"]`. A read endpoint over audit rows is `history: true`.

## D8. Per-route rate limiting [medium]

Grep: `@fastify/rate-limit` registered per route with hand-tuned values.
Fix: `rateLimit: { max, timeWindow }` on `defineResource` (`false` disables), or `createApp({ rateLimit })` globally.
