# Better Auth tables as arc resources

BA writes its own tables (`user`, `organization`, `member`, ...). A kit overlay exposes them as READ resources (pagination, queryparser, OpenAPI, permissions). Overlays are plugin-agnostic: they read `auth.$context.tables`.

The overlay repository is sealed read-only by default. Mutate identities through `auth.api`, never through generic CRUD. `unsafeWritable: true` lifts the seal for admin repair paths only.

## mongokit

```typescript
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { organization } from 'better-auth/plugins/organization';
import mongoose from 'mongoose';
import { createBetterAuthOverlay, registerBetterAuthStubs } from '@classytic/mongokit/better-auth';
import { defineResource } from '@classytic/arc';
import { requireAuth } from '@classytic/arc/permissions';

const auth = betterAuth({
  database: mongodbAdapter(mongoose.connection.getClient().db()),
  plugins: [organization()],
});

// strict:false stubs so populate('user') / ref:'organization' work app-wide
registerBetterAuthStubs(mongoose, { plugins: ['organization'] });

const orgAdapter = await createBetterAuthOverlay({ auth, mongoose, collection: 'organization' });

defineResource({
  name: 'organization',
  adapter: orgAdapter,
  tenantField: false,                       // platform-wide, not tenant-scoped
  permissions: { list: requireAuth(), get: requireAuth() },
});
```

`registerBetterAuthStubs(mongoose, opts)`:

| Option | Purpose |
|---|---|
| `plugins` | `organization`, `organization-teams`, `twoFactor`, `jwt`, `oidcProvider`, `mcp`, `deviceAuthorization` |
| `extraCollections` | Any collection not in the plugin map, e.g. `['apikey', 'passkey']` |
| `modelOverrides` | BA modelName => Mongoose model name |
| `usePlural` | Also register the plural name |
| `idType` | `'objectid'` (default) or `'string'` |

Field-only plugins (`admin`, `username`, `magicLink`, `bearer`) need no entry.

Gotchas:
- `idType` must match the stored `_id` (`typeof doc._id`). A wrong value makes `getById` 404 and `populate` return null with no error. Use `'string'` when `advanced.database.generateId` is overridden.
- `createBetterAuthOverlay` throws when a model for that collection already exists (stub registered, or a second call) and `additionalFields` is passed. Choose stub OR overlay-with-fields per collection.
- Call `ensureBetterAuthSessionTtl(connection)` once at boot: BA creates no TTL index for expired sessions.
- Need `toJSON` stripping or domain repository methods? Hand-roll a `strict: false` Mongoose model on `collection: 'user'`, wrap it with a mongokit `Repository` and `createMongooseAdapter`, and hide secrets with `fields: { password: fields.hidden() }`.

## sqlitekit

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createBetterAuthOverlay } from '@classytic/sqlitekit/better-auth';

const sqlite = new Database('app.db');
const auth = betterAuth({ database: sqlite, plugins: [organization()] });
const orgAdapter = await createBetterAuthOverlay({ auth, db: drizzle(sqlite), collection: 'organization' });

defineResource({ name: 'organization', adapter: orgAdapter, idField: 'id', tenantField: false });
```

Same shape as mongokit: replace `{ mongoose }` with `{ db }`, `additionalFields` with `additionalColumns` (Drizzle column builders), and skip stubs.

## Plugin matrix

| BA plugin | Tables | Arc side |
|---|---|---|
| core (emailAndPassword, OAuth) | `user`, `session`, `account`, `verification` | Optionally overlay `user` |
| `organization()` | `organization`, `member`, `invitation` | `orgContext: true`; overlay as needed |
| `organization({ teams: { enabled: true } })` | + `team`, `teamMember` | `requireTeamMembership()` on `scope.teamId` |
| `twoFactor()` | `twoFactor` | Overlay if exposed |
| `admin()` | fields on `user` | `requireRoles(['admin'])` reads the platform role |
| `bearer()` | none | Header transport; see auth-better-auth.md |
| `apiKey()` from `@better-auth/api-key` | `apikey` | auth-api-keys.md |
| `passkey`, `oidcProvider`, `mcp`, `deviceAuthorization`, `magicLink`, `username` | varies | List in `plugins` or `extraCollections` |

Import plugins from dedicated paths (`better-auth/plugins/organization`, `.../admin`, `.../two-factor`, `.../bearer`) for tree-shaking.

Multi-plugin example: one `registerBetterAuthStubs(mongoose, { plugins: ['organization'], extraCollections: ['apikey'] })`, then one overlay call per table (`organization`, `member`, `apikey`, `twoFactor`, `user`).

Runnable references: `playground/better-auth/mongo/` and `playground/better-auth/sqlite/`.
