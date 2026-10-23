# Recipe: Mongoose repositories to mongokit

For the full mongokit API, see the mongokit skill. This file covers what an arc audit recommends.

mongokit wraps a Mongoose model in a `Repository<TDoc>` that satisfies repo-core's `StandardRepo`, so it plugs into arc through `createMongooseAdapter(Model, repo)` from `@classytic/mongokit/adapter` with no casts. It does not own the connection (`mongoose.connect()` stays in `beforeBoot`) and does not strip response fields (arc `fieldRules.hidden` does).

## Signals

| Signal | Grep or check |
|---|---|
| mongoose without mongokit | `package.json` has `mongoose`, lacks `@classytic/mongokit` |
| per-model repository class | `class \w+Repository\b` |
| scattered hooks | `schema\.pre\(`, `schema\.post\(` |
| toJSON transform | `schema\.set\(['"]toJSON` |
| manual pagination | `skip\(.*page`, `countDocuments\(` |
| tenant filter per method | `organizationId` read from `req.user` beside `find` |
| session threading | `startSession\(`, `commitTransaction` |
| duplicate checks by lookup | `findOne\(\{ email` before `create` |

A 150-line repository class usually becomes about 10 lines.

## Mapping

| Hand-rolled | mongokit |
|---|---|
| `class UserRepository { create() { Model.create() } ... }` | `createRepository(Model, config)` |
| `pre('save')` stamping `updatedAt` | `timestamps: true` |
| `{ deletedAt: null }` on every read, restore handler | `softDelete: true` |
| `organizationId` appended to every query | `tenant: { tenantField: "organizationId", required: true }` |
| skip/limit plus `countDocuments` | `repo.getAll({ mode: "offset", page, limit, filters, sort }, scope)` |
| cursor pagination by hand | `repo.getAll({ mode: "keyset", after, limit, sort }, scope)` |
| `findOne` then `create` uniqueness | unique index plus `validationChainPlugin([uniqueField("email")])`, `isDuplicateKeyError` |
| `findOneAndUpdate(..., { runValidators })` | `repo.update(id, data, scope)` |
| `startSession` plus `withTransaction` | `repo.withTransaction(async (tx) => ...)` or `withTransaction(connection, fn)` |
| cache around `find` | `cache: {...}` option |
| audit rows in handlers | `audit: {...}` option |
| prefixed ids (`ord_...`) | `customId: {...}`, `prefixedId`, `sequentialId` |
| status change with legality check | `repo.applyTransition` |
| URL query to filter | `QueryParser` |

## Recipe

Before:

```ts
export class UserRepository {
  async getById(id: string, orgId: string) {
    return User.findOne({ _id: id, organizationId: orgId, deletedAt: null }).lean();
  }
  async list(orgId: string, page: number, limit: number) {
    const query = { organizationId: orgId, deletedAt: null };
    const docs = await User.find(query).skip((page - 1) * limit).limit(limit).lean();
    return { docs, total: await User.countDocuments(query) };
  }
  // update, softDelete, restore, uniqueness check: 60 more lines
}
userSchema.pre("save", function (next) { this.updatedAt = new Date(); next(); });
userSchema.set("toJSON", { transform: (_d, ret) => { delete ret.password; return ret; } });
```

After:

```ts
// user.repository.ts
import { createRepository } from "@classytic/mongokit";
import { User } from "./user.model.js";

export const userRepo = createRepository(User, {
  tenant: { tenantField: "organizationId", required: true },
  softDelete: true,
  timestamps: true,
});

// user.resource.ts
import { defineResource, requireRoles } from "@classytic/arc";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";

export const userResource = defineResource({
  name: "user",
  adapter: createMongooseAdapter(User, userRepo),
  presets: ["softDelete"],
  permissions: { list: requireRoles(["admin"]), get: requireRoles(["admin"]), create: requireRoles(["admin"]), update: requireRoles(["admin"]), delete: requireRoles(["admin"]) },
  schemaOptions: { fieldRules: { password: { hidden: true }, organizationId: { systemManaged: true } } },
});
```

`createRepository` installs plugins in the safe order (tenant before soft delete and cache, soft delete before batch). Hand-built `new Repository(Model, [...])` chains must keep that order.

## Where tenancy lives

One layer. Arc's `multiTenant` preset is the HTTP and MCP boundary and threads scope into the repo call. The repository `tenant` option protects non-HTTP callers (jobs, CLI) and is a safe second layer. Reads through the raw Mongoose model skip tenant, soft delete and cache: flag them.

## Order of adoption per model

1. Replace the repository class with `createRepository`.
2. Delete `pre('save')` stamping and the `toJSON` transform; declare `fieldRules` on the resource.
3. Convert remaining schema hooks to `repo.on("before:create" | "after:update" | ..., fn)`.
4. Replace pagination wrappers with `getAll`.
5. Wire `createMongooseAdapter(Model, repo)`; leave `schemaGenerator` at its default.
6. Run the existing tests unchanged; mongokit defaults match Mongoose semantics.

## Not mongokit's job

Connection lifecycle, response transforms (`_id` to `id`, field stripping), runtime type generation, CLI scaffolding (`arc generate` does that).
