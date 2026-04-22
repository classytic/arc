# Factory

**Summary**: `createApp` is the main entry point. It builds a Fastify instance, registers resources, wires plugins, and returns the app.
**Sources**: src/factory/.
**Last updated**: 2026-04-21.

---

## Entry

```ts
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  resources: [...],                 // or resourcesDir: './src/resources'
  auth: { ... },                    // → [[auth]]
  events: { transport: ... },       // → [[events]]
  plugins: { health: true, ... },   // → [[plugins]]
  cors, logger, openapi, mcp,
});
```

`toPlugin()` was removed in v2.5.2 — pass `resources` directly. See [[removed]].

## Resource loading

Two paths:
1. `resources: [defineResource(...), ...]` — explicit list.
2. `resourcesDir: './src/resources'` — filesystem auto-discovery via `factory/loadResources`.

`ArcDynamicLoader` (old `@classytic/arc/dynamic`) was removed in v2.10. `loadResources` is the only filesystem loader.

## Plugin wiring order matters

Auth → context → org → permissions → resources → events → caching → docs. `createApp` manages the order; do not reorder manually.

## Related
- [[core]] — what `defineResource` produces
- [[plugins]] — which plugins auto-load and which are opt-in
