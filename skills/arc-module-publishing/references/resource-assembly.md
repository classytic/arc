# Resource assembly inside a module

## 1. Type the engine port with the kernel's own bags

The kernel is already your peer, so indexing its engine type adds no coupling and its truths (optional members, literal unions) flow into your builders.

```ts
import type { CatalogEngine } from "@classytic/catalog";

export interface CatalogEngineLike {
  models: CatalogEngine["models"];
  repositories: CatalogEngine["repositories"];
}
```

Never redeclare the bags as `Record<string, unknown>`: that forces `as never` at every adapter.

## 2. Merge base config and host seams

`mergeResourceConfig(base, ...seams)` is arc's slot-aware merge. Later seams win, `undefined` never overwrites.

| Slot kind | Merge |
|---|---|
| top-level arrays (`routes`, `middlewares`, `presets`, `routeGuards`, `disabledRoutes`) | concat, base first |
| plain objects (`permissions`, `actions`, `schemaOptions`, `fieldRules`, `aggregations`, `customSchemas`, `fields`, `cache`, `events`) | recursive per key; nested arrays replace |
| class instances and scalars (`adapter`, `controller`, `queryParser`) | last wins |

```ts
import { defineResource, mergeResourceConfig, type ResourceSeams } from "@classytic/arc";
import { permissionMatrix } from "@classytic/arc/permissions";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";

export interface ProductSeams {
  extraRoutes?: ResourceSeams["routes"];
  extraActions?: ResourceSeams["actions"];
  cache?: ResourceSeams["cache"];
}

export function productResource(engine: CatalogEngineLike, deps: Deps, cfg: ProductSeams = {}) {
  return defineResource(
    mergeResourceConfig(
      {
        name: "product",
        adapter: createMongooseAdapter(engine.models.Product, engine.repositories.product),
        permissions: permissionMatrix({ read: deps.permissions.view, write: deps.permissions.manage }),
      },
      { routes: cfg.extraRoutes, actions: cfg.extraActions, cache: cfg.cache },
    ),
  );
}
```

`ResourceSeams` is `ResourceConfig` minus `name`, with `adapter` widened through `AdapterLike`, `undefined` accepted, and `readonly` arrays accepted. Expose your own seam names as projections of its slot types.

Remaining honest casts: wire-body narrowing inside action handlers (narrow to the kernel's union, not `string`) and id widening at a kernel bridge. Anything else is a smell.

## 3. Declare the wire contract once

Use zod v4 for CRUD bodies and custom routes. AJV validates, a preHandler parses, the handler reads the parsed value, OpenAPI and MCP derive from the same schema.

```ts
import { crudInput, parsed, routeInput } from "@classytic/arc/core";
import { z } from "zod";

const create = z.strictObject({ name: z.string().trim().min(1), rank: z.number().default(1) });
const update = create.partial();
const search = z.object({ q: z.string().trim().min(1), limit: z.coerce.number().int().min(1).default(10) });

defineResource({
  name: "gadget",
  adapter,
  ...crudInput({ create, update, parse: true }),
  routes: [
    {
      method: "GET",
      path: "/find",
      permissions: allowPublic(),
      ...routeInput({ querystring: search }),
      rawHandler: async (req, reply) => reply.send(await find(parsed(search, req.query))),
    },
  ],
});
```

- `crudInput({ create, update, parse? })` returns `customSchemas`, `openApiSchemas` and, with `parse: true`, create and update middlewares. It writes `middlewares`: merge your own with `middlewares: { create: [...mine, ...crud.middlewares.create] }`.
- A failed parse is a 400 `arc.validation_error` with field `details`.
- A `.default()` field stays optional on the wire (the schema is converted in the input direction).
- Pass `strictSchemas: true` to `defineResource` (or set `ARC_STRICT_SCHEMAS=true`) so a `{ body: X }` wrapper in an action schema is a define-time error instead of a `schema.slot_wrapper` warning.

## 4. Permissions

```ts
permissions: permissionMatrix({ read: deps.permissions.view, write: deps.permissions.manage, delete: deps.permissions.remove })
```

Expands to `list`, `get`, `create`, `update`, `delete`. The package takes `PermissionCheck` values from the host and never invents role names.

## 5. Tenancy and fields

- `tenantField` defaults to `organizationId`. Set `tenantField: false` for company-wide lookup tables.
- A custom controller must receive `tenantField`, `idField` and `schemaOptions` through its constructor and mirror them on `defineResource`. Prefer no custom controller.
- Hide sensitive fields with `schemaOptions.fieldRules: { password: { hidden: true } }`.
