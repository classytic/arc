# Querying: parser, aggregations, query cache

## List query

```
GET /products?page=2&limit=20&sort=-createdAt&select=name,price
GET /products?price[gte]=100&status[in]=active,featured&search=keyword
GET /products?after=<cursor>&limit=20                       keyset
GET /products?populate[category][select]=name,slug
GET /products?filter[status]=active&filter[price][gte]=100  bracket envelope
```

Operators: `eq ne gt gte lt lte in nin like regex exists`.

```typescript
import { QueryParser } from '@classytic/mongokit';

defineResource({
  queryParser: new QueryParser({
    allowedFilterFields: ['status', 'category'],
    allowedSortFields: ['createdAt', 'price'],
    allowedOperators: ['eq', 'gte', 'lte', 'in'],
    strictFilterFields: true,          // unknown filter key = 400 instead of dropped
  }),
  schemaOptions: { query: { allowedPopulate: ['category'], allowedLookups: ['categories'] } },
});
```

- An unknown filter key is DROPPED by default, which WIDENS the result (200 with every row). Set `strictFilterFields: true` or `ARC_STRICT_QUERY_PARAMS=true`.
- `?limit` above the cap is clamped, not rejected; the cap is in the OpenAPI parameter description.
- One cap, one owner: parser, repository and arc all cap page size and the lowest wins. Configure the same number everywhere; arc warns at boot on a mismatch.
- `limit` is `defaultLimit` / `maxLimit` on the resource.

## Aggregations

`GET /:prefix/aggregations/:name`, portable `$match -> $group -> $project -> $sort -> $limit` through `repo.aggregate(req, options)`.

```typescript
import { defineAggregation, defineResource } from '@classytic/arc';

aggregations: {
  byMethod: defineAggregation({
    groupBy: 'method',
    measures: { total: 'sum:amount', count: 'count' },
    sort: { total: -1 },
    cache: { staleTime: 60, swr: true, tags: ['revenue'] },
    permissions: canViewRevenue(),
  }),
  byDay: defineAggregation({
    dateBuckets: { day: { field: 'createdAt', interval: 'day' } },
    measures: { total: 'sum:amount' },
    requireDateRange: { field: 'createdAt', maxRangeDays: 365 },
    permissions: canViewRevenue(),
  }),
}
```

Guards: `requireFilters`, `requireDateRange`, `maxGroups`. Every aggregation is also an MCP tool. Tenant scope travels in `options`, not in `filter`. With no repository and no `materialized`, `defineResource()` throws.

`materialized: async (ctx) => ...` owns dispatch when the portable IR cannot express the query. `ctx.filter` carries only the declaration filter and query string: tenant is `ctx.orgId`, soft-delete is not merged. Route through the kit's pipeline call (mongokit `aggregatePipeline(pipeline, { organizationId: ctx.orgId, ... })`) so tenant, soft-delete and audit hooks run; never call the driver (`Model.aggregate`) directly.

## Query cache

```typescript
createApp({ arcPlugins: { queryCache: true } });
defineResource({
  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'],
           invalidateOn: { 'category.*': ['catalog'] }, list: { staleTime: 60 }, byId: { staleTime: 10 } },
});
```

SWR with auto-invalidation: POST/PATCH/DELETE bump the resource version. Header `x-cache: HIT | STALE | MISS`. `runtime: 'distributed'` needs `stores.queryCache` (a Redis cache store).

## Query contract in the spec

The list operation carries `x-arc-query: { filterFields?, operators?, sortFields? }`, taken from the `queryParser` allow-lists (`allowedFilterFields`, `allowedOperators`, `allowedSortFields`); absent when none is declared. `@classytic/arc-testkit` `checkFilterDeclarations` checks a UI against it.
