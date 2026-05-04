# Mongoose → @classytic/mongokit Migration

For projects that have arc installed but still use raw Mongoose models with hand-rolled repository classes, manual pagination, scattered `pre`/`post` hooks, and per-schema `toJSON` transforms.

Mongokit is a Mongoose enhancement layer that:
- Wraps a `mongoose.Model` in a `Repository<TDoc>` that implements `MinimalRepo` + `Partial<StandardRepo>` from `@classytic/repo-core` (so it plugs into the arc adapter with no casts).
- Ships the **arc adapter itself** at `@classytic/mongokit/adapter` (since 3.13.0 / arc 2.12). Through arc 2.12 the adapter lived in arc; in arc 2.12 every kit-specific adapter moved out (Mongoose to mongokit, Drizzle to sqlitekit, Prisma to prismakit) so arc no longer pulls a DB driver into any consumer's resolution graph.
- Provides 15+ plugins: `timestampPlugin`, `softDeletePlugin`, `multiTenantPlugin`, `validationChainPlugin`, `cachePlugin`, `auditTrailPlugin`, `auditLogPlugin`, `cascadePlugin`, `customIdPlugin`, `observabilityPlugin`, `elasticSearchPlugin`, `mongoOperationsPlugin`, `aggregateHelpersPlugin`, `fieldFilterPlugin`, `batchOperationsPlugin`.
- Ships `QueryParser`, `AggregationBuilder`, `LookupBuilder`, `PaginationEngine` (offset + keyset auto-detect).
- Provides `withTransaction` helper with auto-retry and standalone fallback.

**It does NOT**:
- Set `schema.set('toJSON', ...)` — read transforms are framework/controller responsibility (arc handles it via `fieldRules.hidden`).
- Own connection lifecycle — `mongoose.connect()` stays in your bootstrap.

---

## Detection — is mongokit migration needed?

Add to the audit detection sweep:

| Signal | Detection |
|---|---|
| Mongoose without mongokit | `package.json`: `mongoose` present, `@classytic/mongokit` absent |
| Per-model repo class | `Grep "class \\w+Repository\\b"` — count classes |
| Manual `pre`/`post` hooks | `Grep "schema\\.(pre\\|post)\\(['\"]"` |
| Hand-rolled `toJSON` | `Grep "schema\\.set\\(['\"]toJSON\\|toJSON\\s*=\\s*function"` |
| Manual pagination | `Grep "skip\\(.*page\\|countDocuments\\("` |
| Per-method tenant filter | `Grep "organizationId.*req\\.user\\|orgId.*scope"` (paired with `find` / `findOne`) |
| Manual `findByIdAndUpdate(..., { runValidators: true })` | `Grep "runValidators"` |
| Manual transaction session threading | `Grep "session.*startSession\\|session\\.commitTransaction"` |

If `mongoose` deps + `@classytic/mongokit` absent → every model is a candidate. Estimate: a typical 150 LOC repo class shrinks to ~30 LOC with mongokit + plugins.

---

## Mapping table — Mongoose pattern → mongokit replacement

| Hand-rolled Mongoose | Mongokit replacement |
|---|---|
| `class UserRepository { async create(d) { return User.create(d) } /* + 15 more */ }` | `new Repository(User)` (or extend for domain verbs) |
| `userSchema.pre('save', function(next) { this.updatedAt = new Date(); next(); })` | `timestampPlugin()` |
| `userSchema.set('toJSON', { transform: (_, ret) => { delete ret.password; ... } })` | Arc `fieldRules: { password: { hidden: true } }` (mongokit doesn't do this) |
| `Model.find({ deletedAt: null, ...filters })` everywhere | `softDeletePlugin({ deletedField: 'deletedAt' })` |
| `Model.find({ ...filters, organizationId: orgId })` everywhere | `multiTenantPlugin({ tenantField: 'organizationId', contextKey: 'organizationId' })` |
| Manual pagination wrappers (skip/limit + countDocuments) | `repo.getAll({ page, limit, sort })` (offset) or `repo.getAll({ sort, after: cursor })` (keyset auto-detect) |
| `Model.findOne({ email })` for unique check before create | `validationChainPlugin([uniqueField('email')])` |
| Manual `findOneAndUpdate(..., { new: true, runValidators: true })` | `repo.update(id, data)` (validators on by default) |
| Manual `mongoose.startSession()` + `withTransaction` boilerplate | `repo.withTransaction(async (session) => { ... })` |
| Manual cache invalidation around `Model.find` | `cachePlugin({ adapter, ttl, byIdTtl })` |
| Manual audit-log writes on every mutation | `auditTrailPlugin()` + `auditLogPlugin()` |
| Hand-coded URL → query parsing | `new QueryParser({ schema, allowedFilterFields, ... })` |
| Manual `$lookup`/`$match` aggregation building | `AggregationBuilder` / `LookupBuilder` |
| Stripe-style prefixed IDs (`cus_xxx`, `ord_xxx`) | `customIdPlugin({ strategy, publicIdField })` |

Hooks fire with priority ordering: `POLICY` (100, multi-tenant + soft-delete pre-filtering) → `CACHE` (200) → `OBSERVABILITY` (300) → `DEFAULT` (500, user hooks).

---

## Recipe — User model migration

### Before — Mongoose only (~140 LOC)

```typescript
// models/user.ts
import { Schema, model, Document } from 'mongoose';

export interface UserDoc extends Document {
  name: string;
  email: string;
  password: string;
  organizationId: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
  deletedAt: { type: Date, default: null },
  createdAt: { type: Date },
  updatedAt: { type: Date },
});

userSchema.pre('save', function (next) {
  if (this.isNew) this.createdAt = new Date();
  this.updatedAt = new Date();
  next();
});

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

export const User = model<UserDoc>('User', userSchema);
```

```typescript
// repositories/userRepository.ts
import { User, UserDoc } from '../models/user.js';

export class UserRepository {
  async create(data: Partial<UserDoc>, orgId: string) {
    const exists = await User.findOne({ email: data.email });
    if (exists) throw new Error('Email taken');
    return User.create({ ...data, organizationId: orgId });
  }

  async getById(id: string, orgId: string) {
    return User.findOne({ _id: id, organizationId: orgId, deletedAt: null }).lean();
  }

  async list(orgId: string, page: number, limit: number, filters: Record<string, unknown>) {
    const query = { ...filters, organizationId: orgId, deletedAt: null };
    const skip = (page - 1) * limit;
    const docs  = await User.find(query).skip(skip).limit(limit).sort({ createdAt: -1 }).lean();
    const total = await User.countDocuments(query);
    return { docs, total, page, pages: Math.ceil(total / limit) };
  }

  async update(id: string, data: Partial<UserDoc>, orgId: string) {
    return User.findOneAndUpdate(
      { _id: id, organizationId: orgId, deletedAt: null },
      { ...data, updatedAt: new Date() },
      { new: true, runValidators: true },
    ).lean();
  }

  async softDelete(id: string, orgId: string) {
    return User.findOneAndUpdate(
      { _id: id, organizationId: orgId, deletedAt: null },
      { deletedAt: new Date() },
      { new: true },
    ).lean();
  }

  async restore(id: string, orgId: string) {
    return User.findOneAndUpdate(
      { _id: id, organizationId: orgId, deletedAt: { $ne: null } },
      { deletedAt: null },
      { new: true },
    ).lean();
  }
}
```

### After — Mongoose + mongokit (~50 LOC)

```typescript
// models/user.ts (unchanged structure — drop pre('save') and toJSON transform)
import { Schema, model, Document } from 'mongoose';

export interface UserDoc extends Document {
  name: string;
  email: string;
  password: string;
  organizationId: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
  deletedAt: { type: Date, default: null },
  createdAt: { type: Date },
  updatedAt: { type: Date },
});

export const User = model<UserDoc>('User', userSchema);
```

```typescript
// repositories/userRepository.ts
import { Repository, methodRegistryPlugin, timestampPlugin, softDeletePlugin,
  multiTenantPlugin, validationChainPlugin } from '@classytic/mongokit';
import { uniqueField } from '@classytic/mongokit/plugins/validators';
import { User, UserDoc } from '../models/user.js';

export const userRepo = new Repository<UserDoc>(User, [
  methodRegistryPlugin(),
  timestampPlugin(),
  multiTenantPlugin({ tenantField: 'organizationId', contextKey: 'organizationId', required: true }),
  softDeletePlugin({ deletedField: 'deletedAt' }),
  validationChainPlugin([uniqueField('email', 'Email already in use')]),
]);
```

```typescript
// resources/user/user.resource.ts — arc resource consuming the mongokit repo
import { defineResource, requireRoles, allowPublic, fields } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';   // arc 2.12+: from the kit
import { buildCrudSchemasFromModel } from '@classytic/mongokit';
import { User } from '../../models/user.js';
import { userRepo } from '../../repositories/userRepository.js';

export const userResource = defineResource({
  name: 'user',
  adapter: createMongooseAdapter({ model: User, repository: userRepo, schemaGenerator: buildCrudSchemasFromModel }),
  presets: ['softDelete'],          // multiTenant is at the repo layer (mongokit), so we don't need the arc preset too — pick one
  permissions: {
    list:   requireRoles(['admin']),
    get:    allowPublic(),
    create: requireRoles(['admin']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
  schemaOptions: {
    fieldRules: {
      password: fields.hidden(),
      organizationId: { systemManaged: true },
    },
  },
});
```

**What changed:**
- Repository class: 80 LOC → 8 LOC.
- `pre('save')` for timestamps → `timestampPlugin()` (1 line).
- Tenant scoping: 5 duplicated places → 1 plugin.
- Soft-delete with `restore`/`getDeleted`: ~30 LOC → 1 plugin.
- Email uniqueness: hand-coded `findOne` race → `validationChainPlugin([uniqueField(...)])`.
- `toJSON` transform → arc `fields.hidden()` (works on `.lean()` too).
- `findByIdAndUpdate(..., { runValidators: true })` boilerplate → `repo.update(id, data)`.

---

## Where to put multi-tenant scoping — repo or resource?

**Decision rule:** put it in **one** layer, not both. Two recommended patterns:

**Option A — at the repo layer (mongokit plugin):**
```typescript
new Repository(User, [multiTenantPlugin({ tenantField: 'organizationId', contextKey: 'organizationId' })]);
```
- Pros: works for non-HTTP callers (jobs, CLI, hooks). Centralized.
- Cons: requires passing a `RepositoryContext` with `organizationId` to every call.

**Option B — at the arc resource layer (preset):**
```typescript
defineResource({ presets: [{ name: 'multiTenant', tenantField: 'organizationId' }] });
```
- Pros: arc handles context threading from `request.scope` automatically.
- Cons: scoped only to HTTP/MCP entry points; jobs/CLI need to thread context themselves.

**For new code:** prefer (B) — arc is the boundary. If you have non-HTTP entrypoints that hit the same repo, layer (A) on top of (B) and let the repo plugin be a defense-in-depth check (it'll no-op when arc has already injected the filter).

---

## Hook system parity

Mongoose `schema.pre('save', ...)` is per-model and per-method. Mongokit hooks are per-repo and per-event with priority ordering:

```typescript
repo.on('before:create', async (ctx) => { /* validate, mutate ctx.data */ });
repo.on('after:create',  async (event) => { /* event = { context, result } */ });
repo.on('error:create',  async (event) => { /* event = { context, error } */ });
```

**Events:** `before:{create|update|delete|findAll|getById|...}`, `after:*`, `error:*`.
**Priorities:** `POLICY = 100` (filter injection runs first) → `CACHE = 200` → `OBSERVABILITY = 300` → `DEFAULT = 500`.

User hooks default to `DEFAULT` (500). Override with `repo.on('before:create', fn, { priority: HOOK_PRIORITY.POLICY })`.

Migrating Mongoose hooks:
- `schema.pre('save', ...)` (insert + update both) → split into `before:create` and `before:update`.
- `schema.pre('findOneAndUpdate', ...)` → `before:update`.
- `schema.pre('remove', ...)` → `before:delete`.
- `schema.post('save', ...)` → `after:create` / `after:update`.

---

## Pagination

Auto-detected by `getAll`:
```typescript
// Offset (page-based)
await repo.getAll({ page: 2, limit: 20, sort: { createdAt: -1 } });
// → { method: 'offset', docs, total, pages, hasNext, hasPrev }

// Keyset (cursor)
const p1 = await repo.getAll({ sort: { createdAt: -1 }, limit: 20 });
const p2 = await repo.getAll({ sort: { createdAt: -1 }, limit: 20, after: p1.next });
// → { method: 'keyset', docs, hasMore, next }

// Aggregate paginate (with $near rewriting handled)
await repo.aggregatePipelinePaginate(pipeline, { page, limit });
```

Drop hand-rolled `Math.ceil(total / limit)` and pagination DTOs — mongokit returns the envelope.

---

## Transactions

```typescript
await repo.withTransaction(async (session) => {
  await repo.update(id, { status: 'paid' }, { session });
  await invoiceRepo.create(invoiceData, { session });
});
// Auto-retries on TransientTransactionError / UnknownTransactionCommitResult
// Falls back to non-transactional when running on standalone Mongo (with allowFallback: true)
```

Cross-repo transaction:
```typescript
import { withTransaction } from '@classytic/mongokit';
await withTransaction(mongoose.connection, async (session) => {
  await orderRepo.update(id, ..., { session });
  await invoiceRepo.create(..., { session });
});
```

---

## Per-resource adoption order

For each Mongoose model in the project:

1. Drop `pre('save')` for timestamps; add `timestampPlugin()` to the repo.
2. Drop `schema.set('toJSON', ...)`; declare sensitive fields in arc `fieldRules: { password: fields.hidden() }`.
3. Replace the per-model repository class with `new Repository(Model, [...plugins])`.
4. Convert Mongoose hooks (`schema.pre/post`) to `repo.on('before:*'/'after:*', ...)`.
5. If multi-tenant: pick repo-layer or resource-layer scoping (one, not both).
6. If soft-delete: add `softDeletePlugin` (drops the manual `deletedAt: null` filter scattered across reads).
7. Replace pagination wrappers with `repo.getAll(...)`.
8. Wire the repo into the arc resource via `createMongooseAdapter({ model, repository: repo, schemaGenerator: buildCrudSchemasFromModel })`.
9. Run the existing test suite — should pass with no logic changes (mongokit's defaults match Mongoose semantics).
10. Add `npm run typecheck:tests` step in CI to lock conformance with `@classytic/repo-core`'s `StandardRepo`.

---

## Conformance gate

If consumers see `as unknown as RepositoryLike<T>` casts when wiring a repo into the mongoose adapter, that's drift. Mongokit's `tests/unit/standard-repo-assignment.test-d.ts` proves whole-interface assignment via TypeScript. Run `npm run typecheck:tests` in mongokit; if it fails, the published version drifted from the contract — pin to a known-good version or open a PR.

In the client project, prefer `createMongooseAdapter({ model, repository, schemaGenerator })` from `@classytic/mongokit/adapter` over manual `RepositoryLike` shaping — it accepts mongokit-native repos with no casts.

## arc 2.12 / mongokit 3.13.0 — adapter split

Through mongokit 3.12 / arc 2.11, `createMongooseAdapter` shipped from `@classytic/arc`. In mongokit 3.13.0 + arc 2.12, the adapter lives in mongokit at `@classytic/mongokit/adapter`. Coordinated minimums:

| Package | Min |
|---|---|
| `@classytic/arc` | 2.12.0 |
| `@classytic/mongokit` | 3.13.0 |
| `@classytic/repo-core` | 0.4.0 |

Migration shape:

```typescript
// arc 2.x
import { createMongooseAdapter } from '@classytic/arc';
import type { DataAdapter, RepositoryLike, AdapterRepositoryInput } from '@classytic/arc';
import type { InferMongooseDoc, MongooseAdapterOptions } from '@classytic/arc/adapters';

// arc 2.12+
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import type { DataAdapter, RepositoryLike, AdapterRepositoryInput } from '@classytic/repo-core/adapter';
import type { InferMongooseDoc, MongooseAdapterOptions } from '@classytic/mongokit/adapter';
```

The kit owns mongoose as its peer dep; arc dropped both `@classytic/mongokit` and `mongoose` from its `peerDependencies`. Hosts depend on `@classytic/mongokit` directly, which transitively pulls mongoose. Detection regex for stragglers: see `references/anti-patterns.md` §32g.

---

## What mongokit does NOT do

Be explicit so the audit doesn't recommend it for the wrong job:

- **Connection management.** `mongoose.connect()` stays in your bootstrap.
- **Response transforms.** No `_id` → `id` rewriting, no field stripping. Use arc `fieldRules.hidden` or controller-level mapping.
- **Type generation.** No runtime codegen. Declare `interface UserDoc extends Document` manually (or use Mongoose's `InferSchemaType`).
- **Versioning.** Use `mongoOperationsPlugin` + `$inc` on `__v`, or external `mongoose-version`.
- **CLI scaffolding.** Mongokit ships no CLI — use `arc generate resource <name>` which creates a mongokit-style repo.
- **Vector/Atlas Search.** Mentioned in roadmap; not shipped in 3.12.x. Use `elasticSearchPlugin` for ES, or wire your own.
