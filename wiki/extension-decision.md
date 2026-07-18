# Extension-mechanism decision model

**Summary**: One table answering "which extension mechanism do I reach for?" — the canonical hierarchy across modules, plugins, presets, hooks, middleware, pipeline, actions, adapters, and subscribers.
**Sources**: src/core/, src/factory/, wiki pages per mechanism.
**Last updated**: 2026-07-17 (created — 2.23 audit).

---

Arc has many extension seams by design — each exists because a different *kind* of change needs a different blast radius. Pick by NEED, not by familiarity:

| Need | Canonical mechanism | Page |
|---|---|---|
| Change/augment a resource *definition* (add fields, routes, hooks as a reusable unit) | **Preset** | [[presets]] |
| Add a domain operation on a resource (`approve`, `cancel`) | **Action** (id-bound or `id: false`) — falls back to custom route only for non-action shapes | [[core]] |
| Read-shaped custom endpoint / non-CRUD verb | **Custom route** (`routes: []`) | [[core]] |
| Per-request behavior on some operations (guard, transform, intercept) | **Pipeline** (`pipe:`) — functional, MCP-parity | [[core]] |
| Fastify-native preHandler concerns (multipart, raw-body, legacy) | **Middleware** (`middlewares:`) — HTTP-only, no MCP parity | [[core]] |
| React to a committed mutation on ONE resource | **Resource hook** (`hooks.afterCreate`, ...) | [[hooks]] |
| React to domain activity from ANYWHERE (other resources, other processes) | **Event subscriber** (`app.events.subscribe`) | [[events]] |
| Application infrastructure (DB connection, SSE, docs UI) | **Fastify/Arc plugin** in `plugins()` | [[plugins]] |
| Domain init that resources depend on (engines, singletons) | **`bootstrap[]`** (or `beforeBoot()` for pre-Fastify) | [[factory]] |
| Package a bounded domain (resources + engine + wiring) for reuse | **Arc module** (`defineModule`) | [[modules]] |
| Connect persistence | **Kit adapter** (`@classytic/<kit>/adapter`) | [[adapters]] |
| Map domain errors to HTTP shapes | **`errorMappers`** (app- or module-level) | [[plugins]] |
| Per-resource config for a third-party plugin | **`extensions:` namespace** | [[plugins]] |

Rules of thumb:

- **Pipeline over middleware** unless you need the raw Fastify request/reply — pipeline steps run identically on HTTP and MCP; middlewares are HTTP-only.
- **Hook vs subscriber**: hooks are for the resource's own lifecycle (same transaction-ish locality); subscribers are for cross-domain reactions and anything that must survive process boundaries (via Redis Streams/outbox).
- **Preset vs module**: a preset rewrites one resource's config; a module ships resources + infrastructure as a unit. A preset never registers plugins; a module never mutates another module's resources.
- **Action vs custom route**: if it's "verb on an entity" with a body schema, it's an action (gets MCP tool, permission fallback chain, strict-mode parity for free). Custom routes are for everything else.
- Escalate DOWN this list only when the mechanism above doesn't fit — agents and contributors should pick the FIRST match, not the most powerful seam.
