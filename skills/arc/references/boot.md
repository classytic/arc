# Boot: createApp, loadResources, roles, controllers, DX

## createApp

```typescript
import { createApp, loadResources } from '@classytic/arc/factory';

const app = await createApp({
  preset: 'production',                  // production | development | testing | edge
  runtime: 'memory',                     // memory | distributed
  role: process.env.ARC_ROLE as 'api' | 'worker' | 'relay' | 'scheduler' | 'all',
  beforeBoot: async () => { await mongoose.connect(uri); return () => mongoose.disconnect(); },
  resourcePrefix: '/api/v1',
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS!.split(','), credentials: true },
  resources: await loadResources(import.meta.url),
  arcPlugins: { events: true, queryCache: false, sse: false, caching: true },
  stores: { events: new RedisEventTransport({ client: redis }) },   // required when runtime: 'distributed'
});
await app.listen({ port: 8040, host: '0.0.0.0' });
```

Boot order is fixed: `beforeBoot` -> module graph -> arc core -> `plugins` -> `bootstrap[]` -> `resources` -> `afterResources` -> `onReady`.

| Option | Use |
|---|---|
| `beforeBoot` | connect the DB here (runs before Fastify and before resource files import); returned disposer runs on close and on failed boot |
| `resources` | array, or `async (fastify) => [...]` that runs after `bootstrap[]` (repository inside an async-booted engine) |
| `loadResources(import.meta.url, { context, filter })` | auto-discovers `*.resource.ts` (src in dev, dist in prod); `context` threads handles into `(ctx) => defineResource(...)` exports; `filter(absPath)` gates files before import |
| `role` | `api`/`worker` arm no module schedules; `relay` arms only `kind: 'relay'` arms; `scheduler` arms all; `relay`/`scheduler` with `resources` is boot-fatal; default `all` |
| `modules` | `defineModule` units (resources, events, scheduledJobs, healthChecks, errorMappers, workflows) |
| `errorHandler` | `{ errorMappers, includeStack, exposeInternalMessages, notFound }`; `false` registers none |
| `logger.redact` | REPLACES arc's defaults: spread `DEFAULT_LOGGER_REDACT_PATHS` from `@classytic/arc/factory` |
| `stores` | event transport, query cache, idempotency, etc.; arc closes only stores it built |
| `rateLimit.plan` | per-plan ceilings: `{ resolve, limits: { free: { max: 60 }, enterprise: false }, default }` |

`createWorker(sameOptions)` (`@classytic/arc/factory`) boots the headless process: no HTTP, runs events, schedules and relays. Error disclosure (`includeStack`, `exposeInternalMessages`) derives from `preset`, else the environment; host keys merge over the derived pair.

Unknown routes answer `404 { code: 'arc.not_found', message, status, correlationId }` by default. A host that calls `setNotFoundHandler` itself passes `errorHandler: { notFound: false }` (Fastify allows one per scope); `notFound: (request, reply) => ...` replaces arc's.

## Controllers

The auto-built `BaseController` covers every preset. Write one only for domain methods:

```typescript
import { BaseController, type IControllerResponse, type IRequestContext } from '@classytic/arc';

class ProductController extends BaseController<Product> {
  constructor(opts: { tenantField?: string | false; idField?: string } = {}) {
    super(productRepo, { resourceName: 'product', ...opts });
  }
  async getFeatured(req: IRequestContext): Promise<IControllerResponse<Product[]>> {
    return { data: await this.repository.getAll({ filters: { isFeatured: true } }) };
  }
}
```

Slim mixins: `class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController)) {}`.

## DX helpers

```typescript
import { multipartBody } from '@classytic/arc/middleware';
import { defineGuard } from '@classytic/arc/utils';

middlewares: { create: [multipartBody({ allowedMimeTypes: ['image/png'], maxFileSize: 5_000_000 })] }  // no-op for JSON
routeGuards: [tenantGuard.preHandler]                 // every route; order: auth, permissions, cache/idempotency, routeGuards, route preHandler
routes: [{ method: 'POST', path: '/export', handler: 'export', permissions: requireAuth(),
           rateLimit: { max: 5, timeWindow: '1 minute' } }]    // false = never throttle
routes: [{ preAuth: [(req) => { req.headers.authorization = `Bearer ${req.query.token}`; }] }]  // EventSource token
```

- `req: ArcRequest` types `user`, `scope`, `signal`. `request.user` is undefined on public routes: guard it.
- Reply helpers (opt in with `createApp({ replyHelpers: true })`): `reply.sendList(...)`, `reply.stream(readable, { contentType, filename })`.
- `streamResponse: true` routes returning a Web `ReadableStream` (AI SDK UI message stream) are piped for you; manual: `pipeUIMessageStreamToReply` from `@classytic/arc/utils`.
- `verifySignature(body, ...)` needs `req.rawBody`, not the parsed body.

## CLI

`arc init my-api --mongokit --better-auth --ts` scaffolds; `arc generate resource product [--mcp]`; `arc docs ./openapi.json --entry ./dist/index.js`; `arc introspect`; `arc describe <file> --json`; `arc doctor`.
