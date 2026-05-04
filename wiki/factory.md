# Factory

**Summary**: `createApp` is the main entry point. It builds a Fastify instance, registers resources, wires plugins, and returns the app.
**Sources**: src/factory/.
**Last updated**: 2026-04-25 (loadResources `context` + factory-export support; `silent` removed — 2.11.1).

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
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

export default (ctx: AppContext) =>
  defineResource({
    name: 'category',
    adapter: createMongooseAdapter({
      model: ctx.catalog.models.Category,
      repository: ctx.catalog.repositories.category,
      schemaGenerator: buildCrudSchemasFromModel,
    }),
  });

// app.ts
resources: async () => {
  const [catalog, flow] = await Promise.all([ensureCatalogEngine(), ensureFlowEngine()]);
  return loadResources(import.meta.url, { context: { catalog, flow } });
}
```

Detection is `typeof default === 'function'` — `defineResource()` returns a class instance (`typeof === 'object'`), so the two shapes are unambiguous. Async factories awaited; thrown / non-resource returns reported via the injected logger as a distinct "factory failure" diagnostic.

### Logging — inject a logger, omit for silent (v2.11.1)

`loadResources` is silent by default. Inject a `{ warn(msg) }` logger to receive skip + factory-failure diagnostics; omit it for silent operation. The pre-2.11.1 `silent: boolean` flag was removed (it overlapped confusingly with `logger`); migration steps live in [`/changelog/v2.md`](../changelog/v2.md).

## Plugin wiring order matters

Auth → context → org → permissions → resources → events → caching → docs. `createApp` manages the order; do not reorder manually.

## Related
- [[core]] — what `defineResource` produces
- [[plugins]] — which plugins auto-load and which are opt-in
