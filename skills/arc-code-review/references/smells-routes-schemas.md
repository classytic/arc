# Smells: routes, schemas, parsing

Run each grep over `src/` excluding tests, `dist`, `node_modules`. Severity in brackets.

## R1. Manual CRUD routes [high]

Grep: `fastify\.(get|post|patch|put|delete)\(['"]/(\w+)`. Group by path stem; three or more methods on one stem is a `defineResource` candidate. Files named `*Routes.ts`, `*Controller.ts`, `*Handlers.js` signal the same.
Fix: one `defineResource` per entity. See recipe-resource.md.

## R2. Hand-written body schemas and per-handler parsing [medium]

Grep: `schema:\s*\{\s*body`, `properties:\s*\{` near a route, `\.parse\(req\.body`, `\.safeParse\(req\.(body|query)`, `Schema\.parse\(request`.
Smell: the same zod schema is parsed again inside each handler, or a JSON Schema duplicates the model.
Fix: declare the zod v4 schema once; AJV validates, a preHandler parses, the handler reads the parsed value.

```ts
...routeInput({ body: createBody, querystring: listQuery }),
rawHandler: async (req, reply) => reply.send(await svc.create(parsed(createBody, req.body))),
```

CRUD writes use `...crudInput({ create, update, parse: true })`; actions use `defineAction({ schema, parse: true, handler })`. See recipe-schemas-fields.md.

## R3. `{ body: X }` wrapped action schema [high]

Grep: `schema:\s*\{\s*body\s*:` inside `actions:`, `actionSchemas`.
Why: an action `schema` is the body schema itself. A `{ body }` wrapper has no `type` or `properties`, so the action accepts any input. Arc logs `schema.slot_wrapper`; `strictSchemas: true` on `defineResource` (or `ARC_STRICT_SCHEMAS=true`) makes it a define-time error.
Fix: `schema: createBody` (zod v4) or a JSON Schema object with `type: "object"`.

## R4. Manual query parsing [medium]

Grep: `req\.query\.(filter|sort|page|limit|search|q)\b`, `parseInt\(req\.query`, `Number\(req\.query`, `\$regex`, `\$or\s*:\s*\[`.
Why: ReDoS exposure, no field allow-list, drift between resources.
Fix: arc's parser handles filters, operators, sort, pagination, populate, select with depth and length caps. Allow-lists live in `schemaOptions.query` (`filterableFields`, `allowedPopulate`); Mongo-specific grammar uses mongokit `QueryParser` passed as `queryParser`. Do not post-process `select`: arc forwards it untouched for the repository.

## R5. Custom not-found handler [low]

Grep: `setNotFoundHandler`.
Why: `createApp` already answers unknown routes with the ErrorContract 404 `arc.not_found`. Fastify allows one handler per scope, so a second one overrides arc's or throws.
Fix: delete it. To customize, `createApp({ errorHandler: { notFound: (req, reply) => ... } })`; to own it fully, `errorHandler: { notFound: false }`.

## R6. Hand-written error bodies [medium]

Grep: `reply\.code\(4\d\d\)\.send\(\{\s*(error|message)`, `throw new Error\(['"](Unauthorized|Forbidden|Not found)`.
Why: bodies differ per route; clients cannot branch on `code`.
Fix: throw `NotFoundError`, `ValidationError`, `ForbiddenError` or `createDomainError(code, message, status)` from `@classytic/arc/utils`. Map a domain error class once with `defineErrorMapper` in `errorHandler.errorMappers`.

## R7. Hand-maintained OpenAPI [medium]

Files: `openapi.yaml|json`, `swagger.*`, `api-spec.*`; `@fastify/swagger` with hand-written definitions.
Fix: `openApiPlugin` from `@classytic/arc/docs`, or `arc docs <entry-file> openapi.json` in CI. Diff against the old file; differences are bugs on one side.

## R8. Response field stripping by hand [critical]

Grep: `schema\.set\(['"]toJSON`, `toJSON\s*=\s*function`, `delete\s+(ret|obj|doc)\.(password|__v|secret)`.
Why: a new sensitive field leaks until someone remembers; lean reads skip the transform.
Fix: `schemaOptions: { fieldRules: { password: { hidden: true } } }`; role-gated visibility uses top-level `fields: { salary: fields.visibleTo(["admin"]) }`. See recipe-schemas-fields.md.

## R9. Custom search routes [medium]

Grep: `/search`, `/find`, `/lookup` routes with custom parameter parsing.
Fix: arc's `?search=` and filter grammar; for external engines `searchPreset` from `@classytic/arc/presets/search`.

## R10. Ad hoc multipart [medium]

Grep: `multer`, `formidable`, `busboy`, `@fastify/multipart` registered per route.
Fix: `multipartBody({ allowedMimeTypes, maxFileSize })` from `@classytic/arc/middleware` in `middlewares.create`, or `filesUploadPreset` from `@classytic/arc/presets/files-upload`.
