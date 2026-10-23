# Recipe: hand-rolled CRUD to `defineResource`

## Before (about 170 lines per entity)

```ts
fastify.get("/products", async (req) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const filters: any = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.user) filters.organizationId = req.user.orgId;
  const items = await Product.find(filters).skip((page - 1) * 20).limit(20).lean();
  return { items, total: await Product.countDocuments(filters), page };
});
fastify.post("/products", async (req, reply) => {
  if (!req.user?.roles.includes("admin")) throw fastify.httpErrors.forbidden();
  const data = createBody.parse(req.body);
  const item = await Product.create({ ...data, organizationId: req.user.orgId });
  await fastify.events.emit("product.created", { id: item._id });
  return reply.code(201).send(item);
});
// plus GET /:id, PATCH /:id, DELETE /:id with the same glue
```

## After (about 30 lines)

```ts
import { defineResource, allowPublic, requireRoles } from "@classytic/arc";
import { crudInput } from "@classytic/arc/core";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { createRepository } from "@classytic/mongokit";
import { z } from "zod";
import { Product } from "./product.model.js";

const productRepo = createRepository(Product, { softDelete: true, timestamps: true });

const create = z.strictObject({
  name: z.string().trim().min(1),
  price: z.number().min(0),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
});

export const productResource = defineResource({
  name: "product",
  adapter: createMongooseAdapter(Product, productRepo),
  presets: ["softDelete", { name: "multiTenant", tenantField: "organizationId" }],
  permissions: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(["admin"]),
    update: requireRoles(["admin"]),
    delete: requireRoles(["admin"]),
  },
  ...crudInput({ create, update: create.partial(), parse: true }),
  schemaOptions: { fieldRules: { organizationId: { systemManaged: true } } },
});
```

```ts
import { createApp } from "@classytic/arc/factory";

const app = await createApp({
  auth: { type: "jwt", jwt: { secret: process.env.JWT_SECRET! } },
  resources: [productResource],
});
```

What arc now owns: five routes, filters, sort, pagination, tenant scoping, role checks, 400/403/404 error contract, `product.created|updated|deleted` events, OpenAPI and MCP derivation from the same declaration.

## Presets in one place

| Hand-rolled | Preset | Notes |
|---|---|---|
| `/deleted`, restore handler, `deletedAt` filter | `"softDelete"` | adds `GET /deleted`, `POST /:id/restore`; repo filters via `softDelete: true` |
| `GET /slug/:slug` | `{ name: "slugLookup", slugField: "slug" }` | |
| children and tree routes | `"tree"` | |
| `bulkCreate`, `bulkUpdate`, `bulkDelete` | `"bulk"` | |
| tenant filter on every query | `{ name: "multiTenant", tenantField }` | or `tenantFields` for several levels |
| owner filter on every query | `{ name: "ownedByUser", ownerField: "authorId" }` | |
| manual audit writes | `"audited"` | or `audit: true` |

## Slim custom controller

Prefer none. To compose preset behavior in a class instead of rewriting methods:

```ts
import { BaseCrudController, BulkMixin, SoftDeleteMixin } from "@classytic/arc";

class OrderController extends SoftDeleteMixin(BulkMixin(BaseCrudController)) {}
```

Pass `tenantField` and `idField` to `super(...)` and mirror them on `defineResource`. A domain verb that must keep arc's sanitize, tenant and hook pipeline belongs in `actions` or `writes`, not a controller override.

## Rollout order for a large project

1. Auth and scope accessors first: they unlock declarative permissions.
2. Adapters and repositories before resources.
3. Convert one thin resource end to end, then the rest; fold presets into the resource that needs them.
4. Keep old routes alongside new ones behind a path prefix for one release; cut over after consumers confirm.
5. Run `arc docs` and diff against the hand-kept spec.
6. Delete the old code when the sweep shows zero R1, A1, A2 hits.
