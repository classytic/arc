---
name: arc
description: "@classytic/arc: resource-oriented Fastify backend framework. Use for defineResource CRUD, createApp, permissions, presets, route/action validation (zod v4), scheduled and daily jobs, events/outbox, auth (JWT, Better Auth), multi-tenancy, OpenAPI, MCP tools, testing. Triggers: arc, defineResource, createApp, routeInput, scheduledJobs, arc preset, arc permissions."
license: MIT
metadata:
  author: Classytic
  minVersion: "2.46.0"
---

# @classytic/arc

One `defineResource()` = REST + validation + permissions + events + cache + OpenAPI + MCP. Fastify >=5.12, Node >=22, ESM. DB through kits (`@classytic/mongokit`, `sqlitekit`, `prismakit`) over `@classytic/repo-core`.

## Do not hand-roll

| Need | Use |
|---|---|
| CRUD, OpenAPI, MCP tools | `defineResource({ name, adapter, permissions })` |
| Role, ownership, row policy | `@classytic/arc/permissions`: `requireRoles`, `requireOwnership`, `allowPublic({ policy })`, `anyOf` |
| Tenant or user id in a handler | `@classytic/arc/scope`: `requireOrgId`, `getUserId` (never read scope fields) |
| Route body/query/params schema | `routeInput({ body })` from `@classytic/arc/core` |
| CRUD write schema | `crudInput({ create, update })` |
| Action body schema | `actions.x.schema` is the schema itself; `defineAction({ schema, parse: true })`; `noPayloadSchema` |
| Filter, sort, page | resource `queryParser` allow-list, keyset `after` |
| Soft delete, slug, tree, bulk, files | `presets: [...]` |
| Recurring job | module `scheduledJobs` + `lock` or `singleReplica` |
| Once per local day | `scheduledJobs` with `daily: { hour, minute, zone, ledger }` |
| Durable queue | `@classytic/arc/integrations/jobs` |
| Headless worker | `createWorker(sameOptions)` from `@classytic/arc/factory` |
| Counters, quotas | `@classytic/arc/usage`: `usagePlugin`, `requireQuota`; `rateLimit.plan` |
| Events, outbox, webhooks | `@classytic/arc/events`: `createOutboxModule` |
| 404 for unknown routes | built in: `arc.not_found` ErrorContract |
| Tests | `createTestApp`, `expectArc` from `@classytic/arc/testing` |

## Golden path

```typescript
import { defineResource } from '@classytic/arc';
import { createApp, loadResources } from '@classytic/arc/factory';
import { allowPublic, requireRoles } from '@classytic/arc/permissions';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';

export default defineResource({
  name: 'product',
  adapter: createMongooseAdapter({ model: ProductModel, repository: productRepo }),
  presets: ['softDelete', { name: 'multiTenant', tenantField: 'organizationId' }],
  permissions: { list: allowPublic(), get: allowPublic(), create: requireRoles(['admin']),
                 update: requireRoles(['admin']), delete: requireRoles(['admin']) },
  schemaOptions: { fieldRules: { organizationId: { systemManaged: true } } },
});

const app = await createApp({
  preset: 'production', beforeBoot: connectDb,
  auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
  resources: await loadResources(import.meta.url),
});
```

Validated route, parsed once:

```typescript
import { parsed, routeInput } from '@classytic/arc/core';
const body = z.object({ title: z.string().trim().min(2), tags: z.array(z.string()).default([]) });
routes: [{ method: 'POST', path: '/notes', permissions: requireAuth(), ...routeInput({ body }),
  rawHandler: async (req, reply) => reply.send(await notes.create(parsed(body, req.body))) }]
```

Daily job: `scheduledJobs: [{ name: 'sweep', every: 600_000, daily: { hour: 2, zone: 'Asia/Dhaka', ledger }, handler: async (f, ctx) => sweep(ctx?.day) }]`.

Test: `const ctx = await createTestApp({ resources: [productResource] }); expectArc(await ctx.app.inject({ method: 'GET', url: '/products' })).ok();`

## Gotchas

- `{ body: X }` as an action schema validates nothing (no `type`); pass the schema. `strictSchemas: true` makes it fatal.
- `.default()` stays optional on the wire (zod input direction); `.refine()` needs `routeInput` or `parse: true`.
- `request.user` is undefined on public routes: guard it.
- Public + row filter needs `allowPublic({ policy })`, not `allow({ policy })`.
- A non-writable field in a body is 403; an `immutable` field is silently stripped.
- An unknown filter key is dropped (widens results): `strictFilterFields: true`.
- `distributed` runtime needs shared stores and a schedule `lock` or `singleReplica`.
- Own `setNotFoundHandler` needs `errorHandler: { notFound: false }`.
- Refusing hook: `return reply.send(...)` or throw, never a bare send.

## Never

- Hand-written `.parse()` in every handler, cron or marker-row gates, `setInterval` jobs, manual tenant filters.
- A bare `fastify.get()` (bypasses auth, OpenAPI, MCP).
- Reading `node_modules` for the API; deep imports.

## References

- Core: `references/resources.md` defineResource, presets, fieldRules; `references/boot.md` createApp, roles, controllers, CLI; `references/validation.md` zod slots, routeInput; `references/querying.md` parser, aggregations, cache; `references/writes-hooks-errors.md` transactions, hooks, errors, audit
- Jobs: `references/schedules.md` interval and daily jobs, ledger
- Access: `references/permissions-scope.md` checks and scope; `references/auth-strategies.md`, `references/auth-better-auth.md`, `references/auth-better-auth-overlay.md`, `references/auth-api-keys.md`, `references/auth-permissions.md` auth setups; `references/multi-tenancy.md`, `references/tenancy-scope-install.md` tenants; `references/scim.md`, `references/agent-auth.md`, `references/enterprise-auth.md` enterprise auth
- Events: `references/events.md` bus, transports; `references/events-outbox.md` outbox; `references/integrations-jobs.md` BullMQ; `references/integrations-realtime.md` websocket; `references/integrations-webhooks.md`; `references/integrations-workflows.md`
- MCP: `references/mcp-setup.md`, `references/mcp-auth.md`, `references/mcp-custom-tools.md`, `references/mcp-testing.md`
- Ops: `references/production-boot.md` runtime, `references/production-distributed.md` stores table, `references/production-observability.md`, `references/production-shutdown.md`, `references/production-idempotency.md`, `references/production-audit.md`, `references/production-realtime.md`, `references/production-caching.md`, `references/production-api.md` versioning and rate limit, `references/production-reliability.md`, `references/usage-cleanup-capabilities.md` usage, tenant cleanup
- `references/testing.md` test app; `references/api-reference.md` subpath imports
- Skills: `arc-code-review` audit; `arc-module-publishing` ship a module
