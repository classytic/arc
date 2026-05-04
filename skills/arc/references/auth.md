# Arc Authentication & Authorization

## Decision tree — which pattern fits your auth provider

Arc deliberately ships **zero per-provider code**. The contract is `request.scope`. Three shapes cover every realistic provider:

| Where does user data live? | Who writes it? | Pattern |
|---|---|---|
| Your DB | You | **arc JWT / authenticator** — define your User model normally; no overlay |
| The provider's cloud | Provider (Clerk, Auth0, Supabase Auth...) | **authenticate callback** — verify provider JWT, map claims to `request.scope`. Optionally webhook-sync to a local user table for joins |
| Your DB | A library writes it via its own driver (Better Auth) | **kit overlay** — `@classytic/mongokit/better-auth`, sqlite hand-rolled — gives you arc CRUD + queryparser over the library's tables |

**Better Auth is the recommended path** when you want both "users live in my DB" AND "I don't want to hand-roll signup / OAuth / 2FA / orgs". It's the only provider that needs the overlay because it's the only one writing your tables.

For everything else, the canonical primitive is the `authenticate` callback — verify the token, populate `request.scope`. Arc doesn't care which library produced the token.

## Auth Strategies (Discriminated Union)

Auth config uses `type` field to select strategy:

### JWT (`type: 'jwt'`)

```typescript
const app = await createApp({
  auth: {
    type: 'jwt',
    jwt: {
      secret: process.env.JWT_SECRET,      // Required, 32+ chars
      expiresIn: '15m',                    // Access token TTL
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      refreshExpiresIn: '7d',
    },
    // Optional: custom authenticator with JWT helpers
    authenticate: async (request, { jwt }) => {
      const token = request.headers.authorization?.split(' ')[1];
      if (!token) return null;
      const decoded = jwt.verify(token);
      return await User.findById(decoded._id);
    },
  },
});
// Decorates: app.authenticate, app.optionalAuthenticate, app.authorize, app.auth
```

**Token lifecycle:**

```typescript
// Issue tokens
const tokens = app.auth.issueTokens({ _id: user._id, email, role });
// Returns: { accessToken, refreshToken?, expiresIn, tokenType: 'Bearer' }

// Verify refresh token (rejects access tokens)
const decoded = app.auth.verifyRefreshToken(refreshToken);
```

### Better Auth (`type: 'betterAuth'`)

Two pieces — the **request-side bridge** (catch-all `/api/auth/*` route + scope adapter) and the **table-side overlay** (so arc resources can read BA's collections with full pagination / queryparser / OpenAPI).

#### Request-side bridge

```typescript
import { createBetterAuthAdapter } from '@classytic/arc/auth';

const adapter = createBetterAuthAdapter({
  auth,                    // Your betterAuth() instance
  basePath: '/api/auth',
  orgContext: true,        // Extract org membership into request.scope
});

const app = await createApp({
  auth: { type: 'betterAuth', betterAuth: adapter },
});
```

**Org context flow** (when `orgContext: true`):
1. Gets session via `auth.api.getSession()` (in-process, no HTTP round-trip)
2. Reads `session.activeOrganizationId`, or falls back to `x-organization-id` header (needed for API key auth where synthetic sessions have no org context)
3. Looks up org membership via `auth.api.getActiveMember` (or `getActiveMemberRole` with explicit `organizationId` for header-based resolution)
4. Splits roles: `"admin,recruiter"` → `['admin', 'recruiter']`
5. Sets `request.scope`: `{ kind: 'member', organizationId, orgRoles: string[], teamId? }`

> **Arc 2.13+ requires `auth.api.*`** — pass a real `betterAuth()` instance. The pre-2.13 HTTP fallback for org/team lookups was retired.

#### Table-side overlay — read BA's tables as arc resources

Better Auth writes its own tables (`user`, `organization`, `member`, `invitation`, ...) via its own driver. To expose them as arc resources with pagination, queryparser, OpenAPI, audit, permissions, and multi-tenant scope, use the kit-side overlay:

##### Mongoose / mongokit (Tier 2 — convenience factory)

```typescript
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { organization } from 'better-auth/plugins';
import mongoose from 'mongoose';
import {
  createBetterAuthOverlay,
  registerBetterAuthStubs,
} from '@classytic/mongokit/better-auth';

const auth = betterAuth({
  database: mongodbAdapter(mongoose.connection.getClient().db()),
  plugins: [organization()],
  // ...
});

// Bulk-register stubs so `populate('user')` works app-wide.
registerBetterAuthStubs(mongoose, { plugins: ['organization'] });

// Per-resource overlay — ready to plug into defineResource.
const orgAdapter = createBetterAuthOverlay({
  mongoose,
  collection: 'organization',
});

defineResource({
  name: 'organization',
  adapter: orgAdapter,
  tenantField: false,                // platform-wide, not tenant-scoped
  permissions: { list: requireAuth(), get: requireAuth() },
});
```

##### Mongoose / mongokit (Tier 1 — hand-rolled, full control)

When you need custom validators, `toJSON` transforms (e.g., strip `password`), domain methods on the Repository, or special indexes — drop the factory and hand-roll:

```typescript
const userSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    role: { type: [String], enum: SYSTEM_ROLES, default: ['user'] },
    isActive: { type: Boolean, default: true },
    // BA owns these via strict:false overlay; only declare what you need typed
  },
  { strict: false, timestamps: false, collection: 'user' },
);
userSchema.set('toJSON', { transform: (_, ret) => { delete ret.password; return ret; } });
const User = mongoose.model('User', userSchema);

class UserRepository extends Repository<IUser> {
  async getByRole(role: string) { return this.getAll({ filters: { role, isActive: true } }); }
}

defineResource({
  name: 'user',
  adapter: createMongooseAdapter(User, new UserRepository(User)),
  tenantField: false,
  fields: { password: fields.hidden() },     // belt-and-braces
  permissions: { list: requireRoles(['admin']) },
});
```

##### sqlite / sqlitekit (Tier 2 — convenience factory)

Same parallel structure as mongokit. The factory derives the Drizzle table dynamically from BA's resolved schema (`auth.$context.tables`) — `additionalFields`, `modelName` overrides, and plugin schema additions all flow through automatically.

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { createBetterAuthOverlay } from '@classytic/sqlitekit/better-auth';

const sqlite = new Database('app.db');
const auth = betterAuth({ database: sqlite, plugins: [organization()] });
const db = drizzle(sqlite);

// Async because we await BA's resolved schema. Resolves once at boot.
const orgAdapter = await createBetterAuthOverlay({ auth, db, collection: 'organization' });

defineResource({ name: 'organization', adapter: orgAdapter, idField: 'id', tenantField: false });
```

Need a column BA doesn't declare (host-side audit, custom JSON column, etc.)? Pass `additionalColumns`:

```typescript
import { integer, text } from 'drizzle-orm/sqlite-core';

const orgAdapter = await createBetterAuthOverlay({
  auth, db, collection: 'organization',
  additionalColumns: {
    syncedAt: integer('syncedAt'),
    branchType: text('branchType'),       // matches your BA additionalFields entry
  },
});
```

##### sqlite / sqlitekit (Tier 1 — hand-roll for full control)

When you need a custom `SqliteRepository` subclass with domain methods, custom Drizzle column modes (`integer({ mode: 'timestamp_ms' })` for typed Date), or table-level extensions the factory can't express — drop the factory:

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { SqliteRepository } from '@classytic/sqlitekit/repository';
import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter';

export const organizationTable = sqliteTable('organization', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  slug: text('slug'),
  logo: text('logo'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),  // typed Date
  metadata: text('metadata'),
});

class OrgRepository extends SqliteRepository<{ id: string; name: string }> {
  async getActive() { return this.getAll({ filters: { /* ... */ } }); }
}

const db = drizzle(sqliteDatabase);
const repo = new OrgRepository({ db, table: organizationTable, idField: 'id' });
const orgAdapter = createDrizzleAdapter({ table: organizationTable, repository: repo });
```

Reference playgrounds: [`playground/better-auth/mongo/`](../../../playground/better-auth/mongo/) · [`playground/better-auth/sqlite/`](../../../playground/better-auth/sqlite/). Both pass identical 17-scenario smoke suites — same `defineResource` host code, only the kit import differs.

> **Removed in arc 2.13** — `@classytic/arc/auth/mongoose` (the old `registerBetterAuthMongooseModels`). The helper moved to `@classytic/mongokit/better-auth` as `registerBetterAuthStubs`. Same behavior, kit-owned location.

### Better Auth plugin integration matrix

The `auth.api.*` direct in-process API map and `auth.$context.tables` schema introspection let arc and the kit overlays be **plugin-agnostic** — wire any combination of BA plugins, the overlay reads what's there. No per-plugin code in arc/mongokit/sqlitekit.

| BA plugin | Adds tables | Tested in | What you need on the arc side |
|---|---|---|---|
| (core) — `emailAndPassword`, OAuth providers | `user`, `session`, `account`, `verification` | both kits + playground | Nothing extra. Optionally overlay `user` as a resource. |
| `organization()` (built-in) | `organization`, `member`, `invitation` | both kits + playground | `createBetterAuthAdapter({ orgContext: true })`; overlay `organization` / `member` as resources. |
| `organization({ teams: true })` | + `team`, `teamMember` | mongokit | `requireTeamMembership()` works on `scope.teamId`. |
| `twoFactor()` (built-in) | `twoFactor` | both kits | Picked up automatically by overlay; expose `twoFactor` as a resource if needed. |
| `admin()` (built-in) | (field-only, augments `user`) | both kits | `requireRoles(['admin'])` reads the platform role; no extra plumbing. |
| `bearer()` (built-in) | (none — header strategy) | CLI scaffold | Token comes via `Authorization: Bearer <session>` instead of cookie — same `auth.api.getSession()` path. Use for SPA / mobile clients. |
| `apiKey()` from **`@better-auth/api-key`** (separate npm package) | `apikey` | both kits | Arc auto-resolves API key sessions via `enableSessionForAPIKeys: true`; falls back to `x-organization-id` header for org context. See "API Key Auth" below. |
| `magicLink()`, `username()`, `passkey()`, `oidcProvider()`, `mcp()`, `deviceAuthorization()` | varies (passkey: `passkey`; oidc: `oauthApplication`/`oauthAccessToken`; deviceAuth: `deviceCode`) | not in kit tests | Overlay reads them automatically — pass plugin name to `registerBetterAuthStubs` or list under `extraCollections`. |

#### Multi-plugin recipe — combine without overlay code changes

```typescript
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { admin, organization, twoFactor, bearer } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { createBetterAuthOverlay, registerBetterAuthStubs } from '@classytic/mongokit/better-auth';

const auth = betterAuth({
  database: mongodbAdapter(mongoose.connection.getClient().db()),
  emailAndPassword: { enabled: true },
  plugins: [
    organization(),       // adds organization, member, invitation
    twoFactor(),          // adds twoFactor
    admin(),              // augments user with role/banned/banReason
    bearer(),             // header-based session for SPA/mobile
    apiKey({ enableSessionForAPIKeys: true }),   // adds apikey
  ],
});

// One stub-registration call covers the populate('user') / ref:'organization' surface
// for every plugin you've enabled. apikey isn't ref'd by populate so it goes into extras.
registerBetterAuthStubs(mongoose, {
  plugins: ['organization'],
  extraCollections: ['apikey'],
});

// Overlay any of the resulting tables — picks modelName + additionalFields up
// automatically from auth.$context.tables. Tested combinations: organization,
// member, invitation, apikey, twoFactor, user.
const orgAdapter    = await createBetterAuthOverlay({ auth, mongoose, collection: 'organization' });
const memberAdapter = await createBetterAuthOverlay({ auth, mongoose, collection: 'member' });
const apiKeyAdapter = await createBetterAuthOverlay({ auth, mongoose, collection: 'apikey' });
```

Sqlitekit is symmetric — replace `{ mongoose }` with `{ db }` (a Drizzle binding), use `additionalColumns` instead of `additionalFields`, and skip the stub registration step (no `populate()` in Drizzle).

#### Multi-role members — `role: "admin,recruiter,viewer"`

BA's organization plugin stores multiple roles in a single comma-separated `member.role` string (be-prod canonical). The overlay round-trips this unchanged; arc's `requireRoles()` and `requireOrgRole()` split on comma when reading `scope.orgRoles`:

```typescript
// BA writes:                                    arc reads:
// member.role = "admin,recruiter,viewer"   →   scope.orgRoles = ['admin', 'recruiter', 'viewer']

defineResource({
  name: 'invoice',
  permissions: {
    create: requireOrgRole('admin'),         // matches — admin is in the list
    delete: requireOrgRole('owner'),         // does NOT match — string-equality on each role
  },
});
```

Filtering `member` by exact role string with `?role=admin` will NOT match a multi-role member — the column is opaque text, not an array. Filter with `role[like]=admin` (case-sensitive substring) or model membership server-side.

#### `registerBetterAuthStubs(mongoose, opts?)` — full options (mongokit only)

Bulk-registers `strict: false` Mongoose stubs so `populate('user')` / `ref: 'organization'` work app-wide without per-collection schemas. Idempotent — calling twice returns `[]` the second time.

```typescript
registerBetterAuthStubs(mongoose, {
  plugins: ['organization', 'organization-teams', 'mcp', 'oidcProvider', 'deviceAuthorization'],
  extraCollections: ['passkey', 'ssoProvider', 'apikey'],   // anything not in the plugin map
  modelOverrides: { organization: 'OrgRoot' },              // BA modelName → Mongoose model name
  usePlural: true,                                          // register 'organizations' alongside 'organization'
});
```

Plugin keys recognized by the registry: `organization`, `organization-teams`, `twoFactor`, `jwt`, `oidcProvider`, `mcp`, `deviceAuthorization`. Field-only plugins (`admin`, `username`, `magicLink`, `bearer`, `apiKey` field augmentations) need no entry.

**Gotcha — stub already registered + `additionalFields` requested:** `createBetterAuthOverlay` throws when the host called `registerBetterAuthStubs` for the same collection AND now passes `additionalFields` to the overlay. The stub model is already locked to `strict: false` with no extra paths; adding fields after the fact would silently no-op. Call order: register stubs OR overlay-with-additional-fields, not both for the same collection.

### API Key Auth (Better Auth `apiKey()` plugin)

`apiKey` ships as a **separate npm package**: `@better-auth/api-key`. It is NOT exported from `better-auth/plugins` like `organization` / `twoFactor` / `bearer`. Common mistake.

```typescript
import { apiKey } from '@better-auth/api-key';      // ✓ separate package
// import { apiKey } from 'better-auth/plugins';    // ✗ does not exist

const auth = betterAuth({
  // ...
  plugins: [apiKey({ enableSessionForAPIKeys: true })],
});
```

When enabled, Arc's adapter automatically:
- Resolves API key sessions via `enableSessionForAPIKeys: true` (the plugin's option, not arc's).
- Falls back to `x-organization-id` header for org context — API key sessions have no `activeOrganizationId`, so without the header `scope.kind` is `'authenticated'`, not `'member'`.
- Generates OpenAPI security schemes dynamically — `apiKeyAuth` only appears in the spec when the plugin is active.

```
x-api-key: ak_live_...           # Authentication
x-organization-id: org_abc123    # Org context (required for org-scoped resources)
```

**OpenAPI security semantics** (auto-derived; no manual schema):
- Resource paths: `security: [{ bearerAuth: [] }, { apiKeyAuth: [], orgHeader: [] }]`
  - Meaning: bearer token alone **OR** (API key **AND** org header together)
- Auth endpoints: `security: [{ cookieAuth: [] }, { bearerAuth: [] }, { apiKeyAuth: [] }]`
  - No org header required for auth management endpoints

**Overlay the `apikey` table as an arc resource** (admin-only, for issuing/revoking keys via REST):

```typescript
const apiKeyAdapter = await createBetterAuthOverlay({ auth, mongoose, collection: 'apikey' });
// or sqlitekit: { auth, db, collection: 'apikey' }

defineResource({
  name: 'apikey',
  adapter: apiKeyAdapter,
  tenantField: false,                                 // platform-managed, not tenant-scoped
  permissions: {
    list: requireRoles(['admin']),
    get: requireRoles(['admin']),
    create: denyAll('use POST /api/auth/api-key/create'),   // BA owns the issuance path
    delete: requireRoles(['admin']),
  },
  fields: {
    key: fields.hidden(),                             // never expose the raw key after creation
  },
});
```

The plugin also adds a required `configId` field on `apikey` rows and uses `referenceId` (not `userId`) — note when seeding test fixtures.

### Bearer plugin — SPA / mobile clients

For non-cookie clients (React Native, native mobile, headless SPA), enable `bearer()` so sessions travel as `Authorization: Bearer <session-token>` instead of cookies. Same `auth.api.getSession()` path, just a different transport.

```typescript
import { bearer } from 'better-auth/plugins';
const auth = betterAuth({ plugins: [bearer(), organization()] });
```

Arc's adapter handles both transports identically — you don't switch arc config based on which is enabled. Enable both `cookie` (default) + `bearer` for hybrid web + mobile apps.

### CLI scaffolding for Better Auth

`arc init my-api --better-auth --mongokit --ts` prompts for session strategy and api-key:

```
Session strategy [1=Cookie (web app, default), 2=Bearer token (mobile/SPA), 3=Both]: 3
Enable API key plugin (machine-to-machine auth via @better-auth/api-key)? [y/N]: y
```

The scaffold wires `registerBetterAuthStubs(mongoose, { plugins: [...], extraCollections: ['apikey'] })`, conditional plugin imports, and the matching peer dep entries (`@better-auth/api-key` only if you opted in).

### Custom Plugin (`type: 'custom'`)

```typescript
auth: { type: 'custom', plugin: myAuthPlugin }
// Plugin must decorate fastify.authenticate
```

### Custom Function (`type: 'authenticator'`)

```typescript
auth: {
  type: 'authenticator',
  authenticate: async (req, reply) => {
    const session = await validateSession(req);
    if (!session) reply.code(401).send({ error: 'Unauthorized' });
    req.user = session.user;
  },
}
```

### Clerk / Auth0 / Supabase Auth / any cloud SaaS

User data lives in the provider's cloud, not your DB. No tables to overlay — just verify the provider's JWT and map claims to `request.scope`. The same shape works for any cloud auth provider; only the verifier function differs.

```typescript
import { verifyToken } from '@clerk/backend';

await createApp({
  auth: {
    type: 'jwt',                              // arc's plugin handles plumbing
    jwt: { secret: 'unused' },                // overridden by authenticate
    authenticate: async (request) => {
      const token = request.headers.authorization?.slice(7);
      if (!token) return null;
      const claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });

      // Map provider claims → arc scope (same shape BA produces)
      if (claims.org_id) {
        request.scope = {
          kind: 'member',
          userId: claims.sub,
          organizationId: claims.org_id,
          orgRoles: [claims.org_role],
          userRoles: claims.org_role ? [claims.org_role] : [],
        };
      }
      return { id: claims.sub, email: claims.email };
    },
  },
});
```

**Optional: local user table for joins.** If your resources reference users (`Order.userId → populate`), webhook-sync from Clerk into a local `users` collection and treat it as a normal arc resource — no overlay needed because *you* write it.

```typescript
// POST /webhooks/clerk
fastify.post('/webhooks/clerk', { config: { rawBody: true } }, async (req, reply) => {
  // Verify Clerk webhook signature, then upsert into your User collection.
  await User.findOneAndUpdate({ _id: payload.data.id }, payload.data, { upsert: true });
  return { ok: true };
});
```

### Disabled

```typescript
auth: false
```

## Fastify Decorators

| Decorator | Description | JWT | Better Auth |
|-----------|-------------|-----|-------------|
| `fastify.authenticate` | Verify JWT/session, set `request.user` | Yes | Yes |
| `fastify.optionalAuthenticate` | Parse token if present, skip if absent | Yes | Yes |
| `fastify.authorize(...roles)` | Check `user.role`. `authorize('*')` = any auth user | Yes | No |

## Permission Functions

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireTeamMembership,
  allOf, anyOf, when, denyAll,
} from '@classytic/arc';
```

| Function | Description |
|----------|-------------|
| `allowPublic()` | No authentication |
| `requireAuth()` | Any authenticated user |
| `requireRoles(['admin'])` | At least one role matches |
| `requireOwnership('userId')` | Resource owner only (elevated bypasses) |
| `requireOrgMembership()` | Must be org member |
| `requireOrgRole('admin', 'owner')` | Must have org-level role |
| `requireTeamMembership()` | Must have active team |
| `allOf(p1, p2)` | AND — all must pass |
| `anyOf(p1, p2)` | OR — any can pass |
| `denyAll(reason?)` | Always deny |

**Custom permission:**

```typescript
const requirePro = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return { granted: false, reason: 'Auth required' };
  return { granted: ctx.user.plan === 'pro' };
};
```

## Dynamic ACL (DB-managed)

```typescript
import { createDynamicPermissionMatrix } from '@classytic/arc/permissions';

const acl = createDynamicPermissionMatrix({
  resolveRolePermissions: async ({ request }) => aclService.getRoleMatrix(orgId),
  cacheStore: new RedisCacheStore({ client: redis, prefix: 'acl:' }),
});

permissions: { list: acl.canAction('product', 'read') }
```

- Reads org roles from `request.scope.orgRoles`
- Elevated scope bypasses all checks
- Supports `*` wildcard for resource/action
- Cache failures fail open to resolver

## Org Guards

```typescript
import { orgGuard, requireOrg, requireOrgRole } from '@classytic/arc/org';

// Require org context
fastify.get('/invoices', { preHandler: [fastify.authenticate, requireOrg()] }, handler);

// Require specific org role
fastify.post('/invoices', { preHandler: [fastify.authenticate, requireOrgRole('admin')] }, handler);
```

## Request Scope

```typescript
import type { RequestScope } from '@classytic/arc/scope';
import { getUserId, getUserRoles, getOrgId, getOrgRoles, getTeamId } from '@classytic/arc/scope';

// Variants (userId/userRoles on all authenticated variants):
// { kind: 'public' }
// { kind: 'authenticated', userId?, userRoles? }
// { kind: 'member', userId?, userRoles, organizationId, orgRoles: string[], teamId? }
// { kind: 'elevated', userId?, organizationId?, elevatedBy }

const userId = getUserId(request.scope);         // string | undefined
const globalRoles = getUserRoles(request.scope); // string[]
const orgId = getOrgId(request.scope);           // string | undefined
const orgRoles = getOrgRoles(request.scope);     // string[]
```

## Two Role Layers

| Layer | Source | Scope Field | Checked By |
|-------|--------|-------------|------------|
| Global roles | `user.role` | `scope.userRoles` | `requireRoles()`, `authorize()` |
| Org roles | Org membership | `scope.orgRoles` | `requireOrgRole()`, `requireOrgMembership()` |

## Role Hierarchy

```typescript
import { createRoleHierarchy } from '@classytic/arc/permissions';

const hierarchy = createRoleHierarchy({
  superadmin: ['admin'],
  admin: ['branch_manager'],
});

hierarchy.expand(['superadmin']); // → ['superadmin', 'admin', 'branch_manager']
hierarchy.includes(['admin'], 'branch_manager'); // → true
```

## Token Extraction & Revocation

```typescript
auth: {
  type: 'jwt', jwt: { secret },
  tokenExtractor: (req) => req.cookies?.['auth-token'] ?? null,
  isRevoked: async (decoded) => redis.sismember('revoked', decoded.jti),
}
```

## Service Identity (Machine Principals)

Arc distinguishes **machine callers** (API clients, spawned agents, cron workers) from **human users** via `RequestScope.service` — a first-class scope kind with `clientId` + OAuth-style `scopes`. Any auth mechanism (arc JWT, API keys, Better Auth client credentials, mTLS, gateway headers) can install it; arc does not ship a "service token" issuer — the app picks its credential flow and maps the result to scope.

Install service scope from your `authenticate` callback — arc's default JWT verify installs `member` scope by design, so custom authenticators are the extension point:

```typescript
await createApp({
  auth: {
    type: 'jwt',
    jwt: { secret: process.env.JWT_SECRET! },
    authenticate: async (request, { jwt }) => {
      const token = request.headers.authorization?.slice(7);
      if (!token) return null;
      const decoded = jwt.verify(token) as {
        clientId?: string; userId?: string;
        organizationId?: string; scopes?: string[];
      };
      // Machine principal — clientId present, no human user record.
      if (decoded.clientId) {
        request.scope = {
          kind: 'service',
          clientId: decoded.clientId,
          organizationId: decoded.organizationId ?? '',
          scopes: decoded.scopes ?? [],
        };
        return { clientId: decoded.clientId };   // returned value → request.user
      }
      // Human principal — fall through to user lookup.
      return await User.findById(decoded.userId);
    },
  },
});
```

Gate routes on service identity using the scope helpers + a permission builder:

```typescript
import { isService, getClientId, getServiceScopes } from '@classytic/arc/scope';
import type { PermissionCheck } from '@classytic/arc/permissions';

const requireScope = (scope: string): PermissionCheck => (ctx) => {
  if (!isService(ctx.request.scope)) return { granted: false, reason: 'service only' };
  const has = getServiceScopes(ctx.request.scope).includes(scope);
  return has ? { granted: true } : { granted: false, reason: `missing scope: ${scope}` };
};

defineResource({
  name: 'order',
  permissions: { create: requireScope('orders:write') },
});
```

**Mixing humans and services on the same route** — compose arc's builders:

```typescript
// Humans with 'editor' role OR services with 'orders:write' scope
permissions: {
  create: anyOf(requireOrgRole('editor'), requireScope('orders:write')),
}
```

**Audit differentiation** — because `scope.kind === 'service'` carries `clientId` instead of `userId`, your audit plugin's `actor` resolver can tag machine actions distinctly:

```typescript
auditPlugin({
  actor: (request) =>
    isService(request.scope)
      ? { kind: 'service', clientId: getClientId(request.scope) }
      : { kind: 'user', userId: getUserId(request.scope) },
});
```

**Rate-limit separation** — gate a separate bucket per `clientId` so one noisy agent can't starve humans in the same org:

```typescript
rateLimit: {
  keyGenerator: (req) =>
    isService(req.scope) ? `svc:${getClientId(req.scope)}` : `org:${getOrgId(req.scope)}`,
}
```

**Credential-flow choice is the app's** — arc does not pick for you:

| Flow | Wire via `authenticate` callback |
|---|---|
| Arc JWT with `clientId` claim | example above |
| API key in header (DB lookup) | read `x-api-key`, look up client, set `scope` to service |
| Better Auth client credentials | `auth.api.getSession({ headers })`, detect client-credential grant |
| mTLS cert DN → client | read cert from terminator header, map DN → `clientId` |
| OAuth2 client-credentials | verify token via introspection endpoint |

All five produce the same downstream primitive: `RequestScope.service`. Permission builders, audit hooks, and rate-limit keys compose the same way regardless.

## Microservice Gateway Pattern

```
Frontend → API Gateway (Arc + Better Auth) → Downstream Services
                                  ↓
                    Forwards: X-User-Id, X-Org-Id, X-User-Roles
```

Gateway verifies session, downstream services trust headers:

```typescript
// Downstream — no Better Auth needed
const app = await createApp({
  auth: {
    type: 'authenticator',
    authenticate: async (req, reply) => {
      const userId = req.headers['x-user-id'];
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
      req.user = { id: userId, role: JSON.parse(req.headers['x-user-roles'] || '[]') };
    },
  },
});
```
