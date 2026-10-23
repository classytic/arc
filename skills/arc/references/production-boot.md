# Production: boot, runtime, roles, deployment

## Production createApp

```typescript
import { createApp } from '@classytic/arc/factory';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET');
if (!process.env.ALLOWED_ORIGINS) throw new Error('ALLOWED_ORIGINS');

const app = await createApp({
  preset: 'production',
  runtime: 'memory',                    // REQUIRED with preset 'production': 'memory' | 'distributed'
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  cors: { origin: process.env.ALLOWED_ORIGINS.split(','), credentials: true },
  rateLimit: { max: 100, timeWindow: '1 minute' },
  trustProxy: '10.0.0.0/8',             // name the proxies; default false; a hop count is not accepted
  arcPlugins: { queryCache: true, gracefulShutdown: { drainDelayMs: 10_000 } },
});
await app.listen({ port: 3000, host: '0.0.0.0' });
```

| Option | Notes |
|---|---|
| `runtime` | `'memory'` = exactly one instance. `'distributed'` = more than one replica; audited at boot (production-distributed.md) |
| `trustProxy` | `true`, CIDR string/array, or `'loopback'`. Unset behind a proxy makes `request.ip` the proxy |
| `keepAliveTimeout` | Default 72000; keep above the LB idle timeout or you get intermittent 502 |
| `requestTimeout`, `connectionTimeout`, `bodyLimit`, `maxParamLength` | Fastify pass-through (body 1 MiB, param 400) |
| `underPressure` | Production preset sets `maxEventLoopDelay: 3000`; override `{ maxEventLoopDelay: 500 }`, disable `false` |
| `strictResourceDir`, `strictResources` | Throw on empty discovery or duplicate resource names; turn on in production |
| `resourceDir: import.meta.url` | Works from `src/` and `dist/`; a path string resolves against `process.cwd()` |

Response compression is not included: use the reverse proxy or CDN.

## Roles

`role` decides which async machinery mounts (default `'all'`).

| Role | Behavior |
|---|---|
| `api`, `worker` | No module schedule arms run (outbox relay included) |
| `relay` | Only `kind: 'relay'` arms run; declaring `resources` or `resourceDir` throws |
| `scheduler` | Every arm runs; declaring HTTP resources throws |
| `all` | Everything |

`createWorker` (from `@classytic/arc/factory`) and `preset: 'worker'` build headless processes: resources register without mounting routes (`mountRoutes: false`).

## Deployment

| Target | Preset | Entry |
|---|---|---|
| Docker/K8s, Cloud Run, Railway, Render, Fly | `production` | `app.listen()` |
| AWS Lambda, Vercel Serverless, Cloudflare Workers (`nodejs_compat`) | `edge` | `toFetchHandler(app)` |

```typescript
import { createApp, toFetchHandler } from '@classytic/arc/factory';
const app = await createApp({ preset: 'edge', auth: { type: 'jwt', jwt: { secret } } });
export default { fetch: toFetchHandler(app) };
```

`toFetchHandler` buffers both directions: no SSE, streaming or WebSocket. Publish events to a dedicated edge tier for realtime.

## CORS

- Production without `cors.origin` warns. `origin: '*'` with `credentials: true` throws at boot; use an allow-list.
- Arc merges its headers (`x-organization-id`, `x-arc-scope`, `x-request-id`) into a declared `allowedHeaders` list and always exposes its own response headers.
- Mobile webviews (Capacitor, Ionic): add webview origins and expose the Better Auth bearer header.

```typescript
cors: {
  origin: [...webOrigins, 'https://localhost', 'capacitor://localhost'],
  credentials: true,
  exposedHeaders: ['set-auth-token'],   // Better Auth bearer plugin; without it JS cannot read the token
},
trustProxy: true,
```

Add the same origins to Better Auth `trustedOrigins`. Native HTTP clients send no `Origin`; CORS does not apply.

## Security defaults

- Field-write permission denial rejects with 403 listing denied fields; `onFieldWriteDenied: 'strip'` per resource silently drops instead.
- Scope elevation always emits `arc.scope.elevated`: `fastify.events.subscribe('arc.scope.elevated', handler)`.
- `multiTenant` injects the caller's org on update, overwriting a body-supplied `organizationId`.
- `verifySignature(body, secret, sig)` throws `TypeError` unless body is a string or Buffer: register `@fastify/raw-body` and pass `req.rawBody`.
- Upload preset `sanitizeFilename` is strict by default; relax per adapter with `false`, `'*'` or a function.
- Logger redaction defaults to `DEFAULT_LOGGER_REDACT_PATHS` when you pass an object logger without `redact`.

## Multi-domain deployments

Arc owns no domain routing, certificates or wildcard hosts. Resolve a custom tenant domain at a gateway or early plugin, then authorize through the normal permission path. Never treat `Host` or `X-Forwarded-Host` as tenant authorization: it only selects a candidate, membership resolution authorizes it (same rule as `resolveOrgFromHeader`).
