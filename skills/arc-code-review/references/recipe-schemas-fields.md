# Recipe: schemas, parsing, fields, errors

## One zod v4 declaration, three consumers

AJV validates what JSON Schema can express, a preHandler runs the same schema and replaces `body`, `query`, `params` with the parsed value (trim, defaults, refine apply), and OpenAPI plus MCP derive from the declaration. A failed parse is a 400 `arc.validation_error` with field `details`.

### Custom route

```ts
import { parsed, routeInput } from "@classytic/arc/core";
import { z } from "zod";

const body = z.object({ title: z.string().trim().min(2), tags: z.array(z.string()).default([]) });
const query = z.object({ limit: z.coerce.number().int().min(1).default(10) });

routes: [{
  method: "POST",
  path: "/echo",
  permissions: allowPublic(),
  ...routeInput({ body, querystring: query, response: { 200: z.object({ title: z.string() }) } }),
  rawHandler: async (req, reply) => reply.send({ title: parsed(body, req.body).title }),
}],
```

Smell removed: `body.parse(req.body)` at the top of each handler. A plain JSON Schema in a slot is validated by AJV only.

### CRUD writes

```ts
const create = z.strictObject({ name: z.string().trim().min(1), rank: z.number().default(1) });
defineResource({ name: "gadget", adapter, ...crudInput({ create, update: create.partial(), parse: true }) });
```

`crudInput` returns `customSchemas`, `openApiSchemas` and, with `parse: true`, create and update middlewares. It also writes `middlewares`: merge your own with `middlewares: { create: [...mine, ...crud.middlewares.create] }`. A `.default()` field stays optional on the wire. `z.strictObject` refuses unknown keys.

### Actions

```ts
import { defineAction, noPayloadSchema } from "@classytic/arc/core";

actions: {
  close: defineAction({
    schema: z.object({ note: z.string().trim().min(2), urgent: z.boolean().default(false) }),
    parse: true,
    permissions: requireRoles(["admin"]),
    handler: async (id, data, req) => svc.close(id, data.note), // data is the parsed output
  }),
  archive: defineAction({ schema: noPayloadSchema, permissions: requireRoles(["admin"]), handler: async (id) => svc.archive(id) }),
},
// POST /tickets/:id/action  { "action": "close", "note": "done" }
```

The action `schema` IS the body schema. `schema: { body: X }` has no `type` or `properties`, validates nothing and logs `schema.slot_wrapper`; with `strictSchemas: true` on the resource it fails at define time. Without `parse: true` the handler sees what AJV accepted, untouched.

## Hide and gate fields

```ts
import { defineResource, fields } from "@classytic/arc";

defineResource({
  name: "user",
  adapter,
  schemaOptions: { fieldRules: { password: { hidden: true }, mfaSecret: { hidden: true }, organizationId: { systemManaged: true } } },
  fields: {
    salary: fields.visibleTo(["admin", "hr"]),
    email: fields.redactFor(["viewer"], "***"),
    role: fields.writableBy(["admin"]),
  },
});
```

`hidden` applies at serialization for REST and MCP and works with lean reads. `onFieldWriteDenied` defaults to `"reject"` (403 with the denied list); leave it for sensitive resources. Other `fieldRules` flags: `immutable`, `immutableAfterCreate`, `optional`, `nullable`, `preserveForElevated`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`, `description`.

## Errors

```ts
import { createDomainError, defineErrorMapper, NotFoundError } from "@classytic/arc/utils";

throw new NotFoundError("order");                        // 404
throw createDomainError("order.already_paid", "Order already paid", 409);

createApp({
  errorHandler: {
    errorMappers: [defineErrorMapper({ type: BillingError, toResponse: (e) => ({ status: e.status, code: e.code, message: e.message }) })],
  },
});
```

Unknown routes answer the ErrorContract 404 `arc.not_found` by default. Delete custom `setNotFoundHandler`; to change it set `errorHandler: { notFound: fn }`, to own it `notFound: false`.

## Unified list responses

`reply.sendList()` (via `replyHelpersPlugin`) wraps repo-core's `toCanonicalList`; types come from `@classytic/repo-core/pagination`. Do not hand-build `{ items, total, pages }`.
