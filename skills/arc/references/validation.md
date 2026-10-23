# Validation: declare a zod schema once

Zod v4 is accepted in every schema slot. Arc converts it once at registration (`draft-7` for AJV, `openapi-3.0` for docs); plain JSON Schema passes through. Zod stays an optional peer.

## Slots

| Where | Slot | Direction |
|---|---|---|
| `routes[].schema` | `body`, `querystring`, `params`, `headers` | input |
| `routes[].schema.response` | `{ 200: schema }` | output |
| `customSchemas.{list,get,create,update,delete}` | same parts, replaces the generated part wholesale | input / output |
| `actions.<name>.schema` | the body schema itself | input |
| `openApiSchemas` | docs only (`createBody`, `updateBody`, `listQuery`, ...) | input |

Input direction keeps `.default()` optional on the wire and keeps `.transform()` representable. A plain `z.object()` strips unknown keys, so it does not emit `additionalProperties: false` on input; use `z.strictObject()` to reject them. A `z.object` response doubles as a field-stripping contract. `.meta({ description, examples })` flows into OpenAPI and MCP.

## routeInput: AJV + parsed handler input

AJV validates what JSON Schema can express. JSON Schema cannot trim, refine across fields or fill nested defaults, so `routeInput` adds a `preHandler` that runs the same zod schema and replaces `request.body|query|params` with its OUTPUT.

```typescript
import { parsed, routeInput } from '@classytic/arc/core';
import { allowPublic } from '@classytic/arc/permissions';
import { z } from 'zod';

const createNote = z.object({ title: z.string().trim().min(2), tags: z.array(z.string()).default([]) });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).default(20) });

routes: [{
  method: 'POST', path: '/notes', permissions: allowPublic(),
  ...routeInput({ body: createNote, querystring: listQuery, response: { 200: z.object({ id: z.string() }) } }),
  rawHandler: async (req, reply) => {
    const body = parsed(createNote, req.body);   // typed z.output, trimmed, defaulted
    return reply.send({ id: await notes.create(body) });
  },
}]
```

- A failed parse is `400 arc.validation_error` with `details[]` (`path`, `message`), the same wire as an AJV failure.
- A plain JSON Schema slot is AJV-only (no preHandler is added for it).
- `parsed(schema, value)` is a typing helper: it does not parse again.
- `headers` and `response` are schema-only.

## CRUD verbs: crudInput

```typescript
import { crudInput } from '@classytic/arc/core';

defineResource({
  name: 'course', adapter,
  ...crudInput({ create: courseCreate, update: courseUpdate, parse: true }),
});
```

Returns `customSchemas` (what AJV enforces) and `openApiSchemas` (what docs show, instead of the stored model). `parse: true` also returns `middlewares.create|update` that hand the repository the zod output; merge it with your own `middlewares` instead of overwriting.

## Actions

```typescript
import { defineAction, noPayloadSchema } from '@classytic/arc/core';

actions: {
  close: defineAction({
    schema: z.object({ note: z.string().trim().min(2) }),
    parse: true,                 // handler's data is the zod output; default false = what AJV accepted
    permissions: requireRoles(['admin']),
    handler: async (id, data) => tickets.close(id, data.note),
  }),
  touch: { schema: noPayloadSchema, permissions: requireAuth(), handler: async (id) => touch(id) },
}
```

`noPayloadSchema` is plain JSON Schema (`additionalProperties: false`): any stray field is a 400.

## The wrapper pitfall

An action's `schema` IS the body schema. `schema: { body: X }` has no `type` or `properties`, arc reads it as empty, and the action accepts anything with no error.

```typescript
schema: { body: z.object({ note: z.string() }) }   // WRONG: validates nothing
schema: z.object({ note: z.string() })             // right
```

`defineResource()` records a `schema.slot_wrapper` diagnostic (logged at registration) for this shape in action schemas and in route or `customSchemas` slots (`body: { body: X }`). Make it fatal: `strictSchemas: true` on the resource or `ARC_STRICT_SCHEMAS=true`.

## Other rules

- `customSchemas` parts replace generated parts; untouched parts keep auto-generation. Model-required fields the server fills: `schemaOptions.fieldRules: { f: { systemManaged: true } }`.
- Unconvertible zod in a validation slot (`z.date()`, `z.bigint()`, custom checks) fails boot: use the wire form (`z.iso.datetime()`, `z.string()`) and convert in the handler.
- A `.refine()` is not enforced by AJV: it needs `routeInput` / `parse: true`, or do it in the handler.
- A thrown raw `ZodError` from your own `.parse()` is not mapped to a 400 by arc; use `routeInput` or throw `ValidationError`.
