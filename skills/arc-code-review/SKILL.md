---
name: arc-code-review
description: Audit a client codebase that uses @classytic/arc for hand-rolled code arc already provides (CRUD routes, permission checks, scope reads, manual zod parsing, cron gates, cache, mongoose repos) and report prioritized replace-X-with-Y fixes. Use for an arc audit, gap analysis, or refactoring a Fastify service to arc. Triggers: arc audit, arc review, arc smell, arc adoption.
license: MIT
metadata:
  author: Classytic
  minVersion: "2.46.0"
tags:
  - arc
  - code-review
  - audit
  - refactor
---

# arc-code-review

Audit a project that depends on `@classytic/arc`: find code arc generates or enforces, score it, emit a report with a concrete fix per finding. For work on arc itself, use the arc skill.

## Do not hand-roll

| Smell in client code | Arc API | Import |
|---|---|---|
| 5 `fastify.get/post/patch/delete` per entity | `defineResource` | `@classytic/arc` |
| Role or owner checks inside handlers | `requireRoles`, `requireOwnership`, `anyOf`, `allOf` in `permissions` | `@classytic/arc/permissions` |
| `req.user._id`, `req.user.orgId` | `getUserId`, `getOrgId`, `requireOrgId`, `requireUserId` | `@classytic/arc/scope` |
| `.parse()` in every handler, hand-written JSON Schema | zod v4 once: `routeInput`, `crudInput`, `parsed`, `defineAction({ schema, parse: true })`, `noPayloadSchema` | `@classytic/arc/core` |
| `{ body: X }` as an action schema | the action `schema` IS the body schema | `@classytic/arc/core` |
| `toJSON` transform stripping secrets | `schemaOptions.fieldRules` with `hidden`, `fields.visibleTo` | `@classytic/arc`, `@classytic/arc/permissions` |
| Manual `req.query` filter and page parsing | built-in parser, `ArcQueryParser` | `@classytic/arc/utils` |
| `setNotFoundHandler` returning custom JSON | default 404 `arc.not_found`; `errorHandler: { notFound }` | `createApp` option |
| `emit('x.created')` after each write | automatic CRUD events, `eventPlugin`, `defineEvent` | `@classytic/arc/events` |
| `cache.del('list')` after writes | `cache: { staleTime, tags }`, `arcPlugins.queryCache` | `defineResource` option |
| `setInterval`, node-cron, marker rows for once-a-day | `schedulesPlugin` with `daily: { hour, minute?, zone, ledger }`, `DailyLedger`, `createMemoryDailyLedger` | `@classytic/arc/plugins` |
| Hand-wired BullMQ queue | `jobsPlugin`, `defineJob` | `@classytic/arc/integrations/jobs` |
| `Idempotency-Key` table | `idempotencyPlugin` | `@classytic/arc/idempotency` |
| Audit rows written in handlers | `auditPlugin`, `audit: true` | `@classytic/arc/audit` |
| `Model.aggregate([...])` in a route | `aggregations`, `defineAggregation` | `@classytic/arc` |
| Soft delete, slug, tree, bulk, tenant glue | `presets: [...]` | `@classytic/arc/presets` |
| Hand-written MCP tools | `mcpPlugin` | `@classytic/arc/mcp` |
| Webhook HMAC over parsed body | `verifySignature(req.rawBody, ...)` | `@classytic/arc/integrations/webhooks` |
| Repository classes over Mongoose | mongokit `createRepository` (see the mongokit skill) | `@classytic/mongokit` |

## Golden path

1. Read `package.json`: arc, mongokit, repo-core versions. No arc dependency means this skill does not apply.
2. Find `createApp(` and every `defineResource(`; list per resource: permissions, presets, schema, cache, events.
3. Sweep `src/` (skip tests and `dist`) with the greps in references/smells-*.md. Record file:line.
4. Score with references/severity.md. Escalate write paths and auth, webhook or payment code.
5. Write the report. Cite file:line for every finding and show before/after for the first hit of each pattern.
6. Order the plan: auth and scope, then schemas, then CRUD consolidation, then data layer, then jobs and events.

```markdown
# Arc audit: <project>
Arc <ver> | Mongokit <ver or none> | <YYYY-MM-DD> | findings: <c> critical, <h> high, <m> medium, <l> low
## Summary
<removable LOC estimate, top 3 risks>
## Findings (sorted by severity, then occurrence count)
### C1. <title> (<n> hits)
Locations: `src/a.ts:42`  Why: <impact>  Fix: <recipe>
## Plan
1. ...
```

## Gotchas

- Report arc misuse (a bug) separately from a missing arc feature (an opportunity).
- Do not suggest a feature the app has not enabled; say to enable it first (`arcPlugins.queryCache`, `eventPlugin`).
- A pattern repeated 30 times outranks one isolated high.
- `softDelete` preset adds routes only; filtering lives in the repository (`softDelete: true`).
- Hosts needing calendar cron or durable retries legitimately use `jobsPlugin`; do not flag them.
- `schemaGenerator: false` on the mongokit adapter silently drops OpenAPI and MCP bodies.
- Tenant config key is `tenantField`; an unknown key is ignored and queries go unscoped.

## Never

- Recommend a deep import or a driver import outside the model, repository and adapter files.
- Rewrite without citing the arc API and subpath in the fix.
- Edit client code unless asked.

## References

- [references/smells-routes-schemas.md](references/smells-routes-schemas.md): read for route, schema, query, not-found, OpenAPI smells.
- [references/smells-auth-scope.md](references/smells-auth-scope.md): read for permission, scope, tenant, webhook, SSE smells.
- [references/smells-data-events.md](references/smells-data-events.md): read for driver, repository, event, cache, audit smells.
- [references/smells-platform.md](references/smells-platform.md): read for job, daily gate, preset, MCP, lifecycle smells.
- [references/smells-imports-style.md](references/smells-imports-style.md): read for canonical import homes and style smells.
- [references/severity.md](references/severity.md): read to score findings and size effort.
- [references/recipe-resource.md](references/recipe-resource.md): read for CRUD to defineResource, presets.
- [references/recipe-schemas-fields.md](references/recipe-schemas-fields.md): read for routeInput, crudInput, actions, hidden fields, errors.
- [references/recipe-scope-permissions.md](references/recipe-scope-permissions.md): read for permissions, scope accessors, tenancy recipes.
- [references/recipe-events-cache-jobs.md](references/recipe-events-cache-jobs.md): read for events, cache, schedules, idempotency, MCP.
- [references/mongokit-repositories.md](references/mongokit-repositories.md): read to replace Mongoose repository classes and wire the adapter.
- [references/arc-cheatsheet.md](references/arc-cheatsheet.md): read for the defineResource surface, scope kinds, presets, subpaths.
- [references/scaffolding.md](references/scaffolding.md): read for arc CLI and generated layout.
