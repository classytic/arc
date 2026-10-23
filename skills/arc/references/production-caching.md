# Production: caching

Three independent layers. Pick one per concern.

| Layer | Enable | Scope |
|---|---|---|
| QueryCache | `arcPlugins.queryCache` plus per-resource `cache` | Server data cache with stale-while-revalidate and mutation invalidation |
| HTTP caching headers | `arcPlugins.caching` | ETag, `Cache-Control`, 304 |
| Response cache | `responseCachePlugin` | In-process LRU of GET responses, per replica |

## QueryCache

```typescript
const app = await createApp({
  arcPlugins: { queryCache: true },                         // memory store
  // distributed: stores: { queryCache: new RedisCacheStore({ client: redis }) }
});

defineResource({
  name: 'product',
  cache: {
    staleTime: 30,                       // seconds fresh, no revalidation (default 0)
    gcTime: 300,                         // seconds stale data is kept, the SWR window (default 60)
    tags: ['catalog'],                   // cross-resource group
    invalidateOn: { 'category.*': ['catalog'] },   // event pattern to tag invalidation
    jitter: 0.1,                         // spread revalidation across keys
  },
});
```

- GET responses carry `x-cache: HIT | STALE | MISS`.
- POST, PATCH, DELETE bump the resource version and invalidate its cached queries; tags invalidate across resources.
- Keys are scoped by user and org, so tenants never share entries.
- `invalidateOn` needs `queryCachePlugin` (enabled by `arcPlugins.queryCache`); without it boot only warns and the rules are ignored.
- `RedisCacheStore` options: `client`, `prefix` (`arc:cache:`), `defaultTtlSeconds` (60), `maxEntryBytes`. Adapt clients with `ioredisAsCacheClient` / `upstashAsCacheClient`.
- Under `runtime: 'distributed'` a memory store fails the boot (production-distributed.md).

## HTTP caching headers

```typescript
createApp({ arcPlugins: { caching: { maxAge: 0, etag: true, conditional: true, methods: ['GET', 'HEAD'], exclude: ['/api/auth'], rules: [] } } });
```

Requires `stores.cache` under `runtime: 'distributed'`.

## Response cache

```typescript
import { responseCachePlugin } from '@classytic/arc/plugins/response-cache';

await fastify.register(responseCachePlugin, {
  maxEntries: 500, defaultTTL: 30,
  rules: [{ match: '/api/products', ttl: 120 }, { match: '/api/users', ttl: 0 }],
  exclude: ['/api/me'],
  eventInvalidation: { patterns: { 'order.*': ['/api/products'] } },
  xCacheHeader: true,
});
fastify.responseCache.invalidate('/api/products');
```

- Per replica by design: correctness comes from short TTLs. Declared `accepted` in the capability audit.
- `responseCache.middleware` must run after authentication; the default key includes user and org.
- Prefer QueryCache when a resource needs shared, tagged invalidation.
