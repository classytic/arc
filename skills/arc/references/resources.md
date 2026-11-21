# defineResource: CRUD, routes, actions, presets

One `defineResource()` call = REST + validation + permissions + events + cache + OpenAPI + MCP.

```typescript
import { defineResource } from '@classytic/arc';
import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';

export default defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  presets: ['softDelete', 'slugLookup', { name: 'multiTenant', tenantField: 'organizationId' }],
  permissions: {
    list: allowPublic(), get: allowPublic(),
    create: requireRoles(['admin']), update: requireRoles(['admin']), delete: requireRoles(['admin']),
  },
  schemaOptions: {
    fieldRules: {
      name: { minLength: 2, maxLength: 200 },
      status: { enum: ['draft', 'active', 'archived'] },
      organizationId: { systemManaged: true, preserveForElevated: true },
    },
    query: { allowedPopulate: ['category'], filterableFields: { status: { type: 'string' } } },
  },
  cache: { staleTime: 30, gcTime: 300, tags: ['catalog'] },
  routes: [{ method: 'GET', path: '/featured', permissions: allowPublic(),
             handler: (ctx) => controller.getFeatured(ctx) }],
  actions: { approve: { handler: approve, permissions: requireRoles(['admin']) } },
});
```

Auto-generated: `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`. Presets add routes (table below). The adapter comes from the kit (`@classytic/mongokit/adapter`, `sqlitekit/adapter`, `prismakit/adapter`); a custom kit implements `DataAdapter` from `@classytic/repo-core/adapter`.

## Custom routes: `handler` vs `rawHandler`

| Field | Signature | Behaviour |
|---|---|---|
| `handler` | `(ctx: IRequestContext)` | arc pipeline: envelope, field-write permissions, MCP tool. The normal form |
| `rawHandler` | `(request, reply)` | Fastify-native: owns the response, no pipeline, no MCP unless `mcpHandler`. Streams, raw-body webhooks, files, redirects |

To reach a controller method, call it: `handler: (ctx) => controller.getStats(ctx)`; set `operation` to keep a stable MCP tool and pipeline name. Both on one route throws at boot. `streamResponse: true` needs `rawHandler`. Custom endpoints belong in `routes:` / `actions:` (they inherit auth, OpenAPI, MCP); a bare `fastify.get()` bypasses all of it. Declare the schema with `routeInput` (see `references/validation.md`).

Actions share one `POST /:id/action` mount (`id: false` mounts `POST /action`); throttle one by making it a route with `rateLimit`. An action with no permission and no `permissions.update` fallback throws at boot (`allowPublic()` to opt out).

## Resource shorthands

```typescript
defineResource({ name: 'currency', adapter, referenceData: true });        // read-only, limit 1000, cached
defineResource({ name: 'health', customRoutesOnly: true, routes: [...] });  // no adapter, no CRUD, no registry
defineResource({ name: 'pipeline', adapter, defaultLimit: 200, maxLimit: 500 });
defineResource({ name: 'webhook', prefix: '/hooks', skipGlobalPrefix: true });
defineResource({ name: 'internal', adapter, mcp: false });                  // no MCP tools
```

## fieldRules

| Flag | Effect |
|---|---|
| `systemManaged` | stripped from body and `required[]`; the framework stamps it |
| `preserveForElevated` | elevated admins keep the field on ingest |
| `immutable` / `immutableAfterCreate` | omitted from update body |
| `optional` | out of `required[]`, property kept |
| `nullable` | type widened to include null |
| `hidden` | blocked from responses, filters, sort and OpenAPI |
| `minLength` `maxLength` `min` `max` `pattern` `enum` `description` | map to AJV and OpenAPI |

Model constraints win; `fieldRules` supplements what the model lacks.

## Presets

| Preset | Adds | Config |
|---|---|---|
| `softDelete` | `GET /deleted`, `POST /:id/restore` | `{ deletedField }` |
| `slugLookup` | `GET /slug/:slug` | `{ slugField }` |
| `tree` | `GET /tree`, `GET /:parent/children` | `{ parentField }` |
| `ownedByUser` | middleware | `{ ownerField }` |
| `multiTenant` | middleware | `{ tenantField }` or `{ tenantFields: [...] }` |
| `audited` | middleware | none |
| `bulk` | `POST/PATCH/DELETE /bulk` | `{ operations?, maxCreateItems? }` |
| `filesUpload` | `POST /upload`, `GET /:id`, `DELETE /:id` | `{ storage, allowedMimeTypes?, maxFileSize? }` |
| `search` | `POST /search`, `/search-similar`, `/embed` | `{ repository?, search?, similar?, embed? }` |

- Preset read routes inherit the CRUD key (`slugLookup`, `filesUpload` read → `get`; `tree`, `search` → `list`); with none they fail boot under `strictPermissions` (`preset-route-public-by-omission`). Public is `allowPublic()`.
- `multiTenant` guards every route: preset routes get their CRUD route's tenant guard, custom `handler` routes the filter; `tenantScope: true` adds body injection (and covers `rawHandler`), `false` opts out.
- `tenantField: false` disables the org filter (lookup tables, platform settings).
- `idField` picks the `:id` lookup column (default `_id`). A 404 on `PATCH` when `GET` works is usually a permission `filters` clause, not `idField`.
- Presets compose and order matters. A custom `controller` does not receive preset-injected fields: forward `tenantField` / `schemaOptions` / `idField` through `super()` and also pass them to `defineResource`, or extend `BaseController`.

## Write behaviour

| Behaviour | Default | Switch |
|---|---|---|
| non-writable field in body | 403 with the denied list | `onFieldWriteDenied: 'strip'` |
| write to an `immutable` field | 403 | `onImmutableWrite: 'strip'` or `ARC_STRICT_IMMUTABLE_WRITES=false` |
| ungated CRUD write | fatal at define time | `strictPermissions: false` (not recommended) |
| multiTenant on update | body org overwritten with caller's scope | none |

Read-only repositories (Better Auth overlays) refuse write routes at boot: disable those routes or use `auth.api`.
