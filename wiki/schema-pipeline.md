# Schema pipeline

**Summary**: How a resource's validation + OpenAPI/MCP schemas are assembled — two halves, six steps, one precedence rule. Read this BEFORE touching anything schema-shaped; the 2.21 precedence bug lived here for months because the layering was undocumented.
**Sources**: src/core/defineResource/schemas.ts (registry half), src/core/defineResource/plugin.ts (route half), src/core/schemaOptions.ts.
**Last updated**: 2026-07-13 (page created — 2.21).

---

## Two halves

1. **Registry/OpenAPI half** — `resolveOpenApiSchemas` (schemas.ts, Phase 7 of defineResource). Produces the metadata that feeds `arc docs`, introspection, and MCP tool schemas.
2. **Route-validation half** — `buildGeneratedCrudSchemas` (plugin.ts). Produces the Fastify `schema` objects that actually validate requests.

Both start from the same `adapter.generateSchemas()` output; they diverge in what they layer on top. A change to one half usually needs a mirror check in the other.

## Registry half — six steps, in order

```
adapter.generateSchemas(schemaOptions, { idField, resourceName })
  → stripSystemManagedFromBodyRequired   fieldRules.systemManaged off required[] (props stay)
  → cleanLegacyObjectIdParams            custom idField ⇒ drop ObjectId pattern on params.id
  → layerQueryParserListQuery            parser getQuerySchema() REPLACES listQuery wholesale
  → applyResourcePaginationCaps          resource defaultLimit/maxLimit onto listQuery
  → mergeUserOpenApiOverrides            config.openApiSchemas — wins over everything
  → convertOpenApiSchemas                Zod → JSON Schema
```

Non-fatal by design: any step throwing degrades to `undefined` metadata with a warn — the resource boots, docs degrade visibly. Every step is pinned by `tests/core/schema-pipeline.test.ts` (characterization — one test per step, with the failure isolation case).

## Route half — the precedence rule (2.21)

`buildGeneratedCrudSchemas(openApi, customSchemas)`: auto-gen builds per-op schemas from the adapter output, then customSchemas layers on top **part-level**:

- A customised schema PART (`body` / `params` / `querystring` / `response`) **replaces** the generated part wholesale. A body schema is a complete wire contract, not a patch.
- Parts the custom schema does NOT touch keep their auto-gen (custom `body` never erases generated `params`).
- Ops with no customSchemas entry keep full auto-gen.

**History (why this is a rule, not a preference):** pre-2.21 this was a deep merge that UNIONED `required[]` — a custom body describing a *different* wire shape (legacy controllers mapping public bodies onto kernel models) still demanded the model's required fields. Dormant while adapters shipped no generator; detonated across 28 production resources when mongokit 3.21 turned generation on by default. Pinned by `tests/core/custom-schemas-precedence.test.ts` + `resource-plugin-schema-synthesis.test.ts`.

## Zod v4 everywhere a schema slot exists (pinned 2.22)

Every schema slot arc accepts — `customSchemas.{op}.{body,querystring,params,response[status]}`, `routes[].schema.*`, and `actionSchemas` — takes a plain JSON Schema **or** a Zod v4 schema. Conversion is ONE-TIME at route registration via `convertRouteSchema`/`toJsonSchema` (`z.toJSONSchema()`, `draft-7` target for Fastify's AJV; `openapi-3.0` for docs); zod stays an optional peer (lazy import; plain JSON Schema passes through untouched). DX notes: `z.number().positive()` → draft-7 numeric `exclusiveMinimum` (AJV-valid), `z.coerce.number()` querystrings coerce under createApp's `coerceTypes: true`, and a `z.object` RESPONSE schema doubles as a field-stripping contract (`additionalProperties: false` — undeclared repo fields never reach the wire). The wiring predates 2.22; the route-layer zod path was untested until `tests/core/zod-route-schemas.test.ts` pinned all slots live.

## Choosing the right knob (decision table)

| Situation | Use |
|---|---|
| Server-computed field the model marks `required` (totals, org id) | `schemaOptions.fieldRules: { field: { systemManaged: true } }` |
| Wire shape ≠ model shape (service-driven create, legacy wire) | `customSchemas: { create: { body } }` — body replaces generated; params/listQuery stay |
| Field must never appear in docs at all | `schemaOptions.excludeFields` |
| Whole resource has no meaningful generated schema | `schemaGenerator: false` on the adapter (last resort — kills OpenAPI for that resource; prefer customSchemas) |
| Doc-only tweak (examples, descriptions) | `openApiSchemas` overrides (registry half only — does NOT affect validation) |

## Related
- [[core]] — defineResource phases
- [[gotchas]] — `select` never normalized; systemManaged vs preserveForElevated
