# Factory

**Summary**: `createApp` is the main entry point. It builds a Fastify instance, registers resources, wires plugins, and returns the app.
**Sources**: src/factory/.
**Last updated**: 2026-08-25 (trustProxy: hop counts removed upstream — name the proxies).

---

## Entry

```ts
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  resources: [...],                 // or resourceDir, or () => Promise<resources>
  auth: { ... },                    // → [[auth]]
  events: { transport: ... },       // → [[events]]
  plugins: { health: true, ... },   // → [[plugins]]
  cors, logger, openapi, mcp,
});
```

## Hardened server contract (2.22 — Fastify best-practices wave)

Full rationale in changelog 2.22 ("hardening wave" sections); the contracts:

- CORS `origin: '*'` + `credentials: true` **throws at boot** (was: silent rewrite to reflect-any-origin). Fixes listed in the error. Policy lives in `factory/security/cors.ts` (`resolveCorsOptions`, pure).
- Client-sent bad bytes are **always 400, never 500** — one primitive (`utils/jsonBody.ts` `parseJsonBody`) backs the JSON / SCIM / JWE parsers; raw cause logged, never wired.
- Unclassified 500 messages sanitized in prod — `errorHandler({ exposeInternalMessages })`; domain-coded 5xx keep their messages.
- Request id is **server-level** (`genReqId: createRequestIdGenerator()`, automatic) so `request.id`, `request.log`'s `reqId`, requestContext, and the echoed header all agree. Exported for standalone use.
- `arcLog` routes through `fastify.log` via `createPinoWriter` (inherits transports/level/redaction); `logger: false` keeps the console fallback.
- Knobs: `requestTimeout`/`connectionTimeout`/`keepAliveTimeout` pass-throughs (no arc defaults — Node ≥18 bounds slow-loris; a forced requestTimeout would 408 slow uploads); `trustProxy` accepts CIDR / named / list / `true` forms — NOT a hop count (fastify 5.12.1 removed `number` and fails closed: a hop count cannot validate the immediate peer, so padded `X-Forwarded-*` would spoof `request.ip`). Default `false` everywhere incl. the production preset (2.24 fail-closed flip; proxied hosts must set it explicitly).
- Multipart caps every busboy dimension (`fields: 100`, `parts: 120` join `fileSize`/`files`); host `limits` deep-merge per key.

## Plan-aware rate limits (2.22)

`rateLimit.plan: { resolve, limits, default }` — `resolve(req)` names the caller's plan per request; `limits` maps plan → `{ max }` ceiling within the shared `timeWindow`, `false` = effectively unlimited. Fail-safe, never fail-open: unknown plans and throwing resolvers fall back to `default`, then the global `max`. When `plan` is set and no `keyGenerator` is supplied, arc defaults to `createTenantKeyGenerator()` so buckets follow actors (org → user → client → IP), not addresses. Timing caveat: the limiter runs BEFORE route-level auth, so `resolve` receives the raw request and may need its own header/token lookup — same caveat as the tenant key generator's IP fallback.

## `beforeBoot` — pre-everything hook (2.21)

`createApp({ beforeBoot: async () => connectDatabase(), ... })` is awaited BEFORE arc does anything: no Fastify instance, no module-thunk resolution, no resource imports yet. The canonical slot for the DB connection and anything module-EVAL-time code depends on (engines registering Mongoose models at import → eager `createIndex` → `buffering timed out` when the connection isn't open). Replaces the hand-orchestrated `await connectDatabase()` + dynamic-import ordering tricks hosts carried in composition roots. Runs after option validation; cleanup stays in `onClose`.

**Option VALUES that need the DB use lazy slots** (2.22): options are built before `createApp` is even called, so an eager Better-Auth adapter (`mongodbAdapter(mongoose.connection.getClient().db())` — needs an OPEN connection) would defeat `beforeBoot`. `auth.betterAuth` accepts a sync/async **thunk** resolved during auth registration (post-`beforeBoot`): `betterAuth: () => createBetterAuthAdapter({ auth: getAuth() })`. Same principle as `resources`-as-factory — anything DB-dependent in options is a function, not a value.

Module graph resolution (thunk imports + `dependsOn` topo-sort) is hoisted right after it — pure, fail-fast, and it lets module-shipped `errorMappers` merge into the error handler (see [[modules]]).

## `createWorker` — the headless process role (2.23)

The SAME options object, two process shapes: `createApp(opts)` serves HTTP; `createWorker(opts)` boots everything runtime-shaped (module lifecycle, events consumers, jobs processors, [[plugins]] `schedulesPlugin`, caching, audit, usage) with ZERO routes — deploy `api ×N, worker ×M` from one composition root. Layered so nothing is forced: the primitive `mountRoutes: false` (resources register registry metadata + adapters without mounting — tenant-purge cascade and per-resource audit keep working on headless replicas), the host-overridable `preset: 'worker'`, and the sugar `createWorker(options, { health? })` returning `ArcWorker { app, exports<T>(), close() }`. The sugar strips the API role's HTTP-surface keys (incl. auth — the BA thunk never runs on workers) and deep-merges `arcPlugins`; opt-in `health: { port }` binds the worker's ONLY listener serving the standard healthPlugin. No Redis required — Mongo-only topologies ride streamline + outbox + `mongokit/lock`.

Operational answers: topology is one codebase, two entrypoints (`server.ts` → `createApp`, `worker.ts` → `createWorker`) run as separate processes meeting only at the DB + shared tiers (the existing `runtime: 'distributed'` contract); the worker binds nothing unless `health.port` opts in. Nobody must run one — single-process hosts keep schedules/jobs inside the API app; workers are for when heavy work competes with request latency. Import home is `@classytic/arc/factory` next to `createApp` (no `./worker` subpath; tree-shaken when unused).

## Resource loading

Three paths:
1. `resources: [defineResource(...), ...]` — explicit list.
2. `resources: async () => [defineResource(...), ...]` — async factory for engine-bound resources (runs after `bootstrap[]`).
3. `resourceDir: './src/resources'` — filesystem auto-discovery via `factory/loadResources`.

`ArcDynamicLoader` (old `@classytic/arc/dynamic`) was removed in v2.10. `loadResources` is the only filesystem loader.

### `loadResources({ context })` — engine-bound resources via auto-discovery (v2.11.1)

Default exports may be a `ResourceLike` OR a factory `(ctx) => ResourceLike | Promise<ResourceLike>`. The factory shape lets engine handles flow into resources without parallel `createXResource(engine)` factory files + a stringly-typed `exclude: [...]` list:

```ts
// resources/catalog/category.resource.ts
import { createMongooseAdapter } from '@classytic/mongokit/adapter';

export default (ctx: AppContext) =>
  defineResource({
    name: 'category',
    // mongokit >=3.21 defaults schemaGenerator (opt out: schemaGenerator: false)
    adapter: createMongooseAdapter({
      model: ctx.catalog.models.Category,
      repository: ctx.catalog.repositories.category,
    }),
  });

// app.ts
resources: async () => {
  const [catalog, flow] = await Promise.all([ensureCatalogEngine(), ensureFlowEngine()]);
  return loadResources(import.meta.url, { context: { catalog, flow } });
}
```

Detection is `typeof default === 'function'` — `defineResource()` returns a class instance (`typeof === 'object'`), so the two shapes are unambiguous. Async factories awaited; thrown / non-resource returns reported via the injected logger as a distinct "factory failure" diagnostic.

### `loadResources({ filter })` — path gate before import (2.21)

`filter: (absolutePath) => boolean` runs on every discovered file BEFORE import — gated files' modules never evaluate (top-level engine construction of disabled features never fires). This is the one-callback replacement for the feature-flag → resource-dir manifest tiered hosts hand-roll. Distinct from `include`/`exclude`, which match resource NAMES after import.

### Logging — inject a logger, omit for silent (v2.11.1)

`loadResources` is silent by default. Inject a `{ warn(msg) }` logger to receive skip + factory-failure diagnostics; omit it for silent operation. The pre-2.11.1 `silent: boolean` flag was removed (it overlapped confusingly with `logger`); migration steps live in [`/changelog/v2.md`](../changelog/v2.md).

## Plugin wiring order matters

Auth → context → org → permissions → resources → events → caching → docs. `createApp` manages the order; do not reorder manually.

## Related
- [[core]] — what `defineResource` produces
- [[plugins]] — which plugins auto-load and which are opt-in
