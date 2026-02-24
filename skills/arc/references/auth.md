# Arc Authentication & Authorization

Arc supports multiple auth strategies. All are optional — pick what fits your app.

## Strategy 1: Arc JWT (`@fastify/jwt` v10)

Built-in JWT auth using `fast-jwt` internally. Zero database coupling.

```bash
npm install @fastify/jwt@^10.0.0
```

```typescript
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  auth: {
    jwt: {
      secret: process.env.JWT_SECRET,    // Required, 32+ chars minimum
      expiresIn: '15m',                  // Access token TTL (default: '15m')
      refreshSecret: process.env.JWT_REFRESH_SECRET, // Optional separate secret
      refreshExpiresIn: '7d',            // Refresh token TTL (default: '7d')
    },
  },
});
// Decorates: app.authenticate, app.authorize, app.auth
```

### Token Lifecycle

```typescript
// Login route — issue tokens after validating credentials
app.post('/login', async (request, reply) => {
  const { email, password } = request.body;
  const user = await authenticateUser(email, password);
  if (!user) return reply.code(401).send({ error: 'Invalid credentials' });

  // Issue access + refresh tokens
  const tokens = app.auth.issueTokens({
    _id: user._id,
    email: user.email,
    roles: user.roles,
    organizations: user.organizations,  // For multi-tenant
  });

  return reply.send(tokens);
});
// Returns: { accessToken, refreshToken?, expiresIn, refreshExpiresIn?, tokenType: 'Bearer' }

// Refresh route — exchange refresh token for new access token
app.post('/refresh', async (request, reply) => {
  const { refreshToken } = request.body;

  // Verifies token AND enforces type === 'refresh' (rejects access tokens)
  const decoded = app.auth.verifyRefreshToken(refreshToken);

  const user = await User.findById(decoded.id);
  if (!user) return reply.code(401).send({ error: 'User not found' });

  const tokens = app.auth.issueTokens({
    _id: user._id, email: user.email, roles: user.roles,
  });
  return reply.send(tokens);
});
```

**Token types:** Access tokens include `type: 'access'`, refresh tokens include `type: 'refresh'`. The `authenticate` middleware automatically rejects refresh tokens used for API access.

### Custom Authenticator (with JWT helpers)

Override the default JWT verify with your own logic while still using Arc's JWT infrastructure:

```typescript
const app = await createApp({
  auth: {
    jwt: { secret: process.env.JWT_SECRET },
    authenticate: async (request, { jwt }) => {
      // Full control — Arc never touches your database
      const token = request.headers.authorization?.split(' ')[1];
      if (!token) return null;
      const decoded = jwt.verify(token);
      return await User.findById(decoded._id);  // Return your user object
    },
  },
});
```

## Strategy 2: Better Auth Adapter

Bridges Better Auth's Fetch API into Fastify. Better Auth is your dependency — Arc only provides a thin adapter.

```bash
npm install better-auth
```

```typescript
import { betterAuth } from 'better-auth';
import { createBetterAuthAdapter } from '@classytic/arc/auth';

// 1. Create your Better Auth instance
const auth = betterAuth({
  database: { ... },
  emailAndPassword: { enabled: true },
  // organization plugin for multi-tenant:
  plugins: [organization()],
});

// 2. Create the adapter
const betterAuthAdapter = createBetterAuthAdapter({
  auth,
  basePath: '/api/auth',    // Default
  orgContext: true,          // Enable org context extraction (default: false)
  // orgContext: { bypassRoles: ['superadmin'] },  // Custom bypass roles
});

// 3. Wire into createApp
const app = await createApp({
  auth: { betterAuth: betterAuthAdapter },
});
```

**What `createBetterAuthAdapter()` returns:**

```typescript
interface BetterAuthAdapterResult {
  plugin: FastifyPluginAsync;       // Catch-all route handler for /api/auth/*
  authenticate: PreHandler;         // Session validation middleware
  permissions: {
    requireOrgRole: (...roles) => PermissionCheck;
    requireOrgMembership: () => PermissionCheck;
    requireTeamMembership: () => PermissionCheck;
  };
}
```

### Org Context Bridge (Better Auth)

When `orgContext: true`, the authenticate middleware automatically:

1. Gets the session via Better Auth's `GET /api/auth/get-session`
2. Reads `session.activeOrganizationId`
3. Looks up org membership via `GET /api/auth/organization/get-active-member`
4. Extracts roles from Better Auth's comma-separated role string (e.g. `"owner,admin"`)
5. Reads `session.activeTeamId` for team context
6. Sets on request:
   - `request.organizationId` — active org ID
   - `request.teamId` — active team ID
   - `request.context.orgRoles` — `string[]` of org-level roles
   - `request.context.orgScope` — `'bypass'` | `'member'` | `'public'`
   - `request.context.teamId` — active team ID

**Bypass roles** (default: `['superadmin']`) skip the membership lookup entirely and get `orgScope: 'bypass'`.

### Team Support (Better Auth)

Better Auth teams are **flat member groups** within an organization (no team-level roles). The team context is automatically bridged when using `orgContext: true`.

**Permission guards:**

```typescript
import {
  requireOrgMembership,
  requireOrgRole,
  requireTeamMembership,
} from '@classytic/arc/permissions';

defineResource({
  name: 'sprint',
  permissions: {
    list: requireOrgMembership(),       // Any org member
    get: requireOrgMembership(),
    create: requireOrgRole('admin', 'owner'),  // Org admin/owner only
    update: requireTeamMembership(),    // Must have active team
    delete: requireOrgRole('owner'),
  },
});
```

**`requireTeamMembership()`** checks:
1. User is authenticated
2. User is a member of the active organization
3. User has an active team (`request.teamId` is set)

**Using `createOrgPermissions()` for scoped permission systems:**

```typescript
import { createOrgPermissions } from '@classytic/arc/permissions';

const perms = createOrgPermissions({
  statements: {
    sprint: ['create', 'update', 'delete'],
    board: ['create', 'manage'],
  },
  roles: {
    owner: { sprint: ['create', 'update', 'delete'], board: ['create', 'manage'] },
    admin: { sprint: ['create', 'update'], board: ['create'] },
    member: { sprint: ['create'], board: [] },
  },
  bypassRoles: ['superadmin'],
});

defineResource({
  permissions: {
    list: perms.requireMembership(),       // Any org member
    create: perms.can({ sprint: ['create'] }),
    update: perms.requireTeamMembership(), // Requires active team
    delete: perms.requireRole('owner'),
  },
});
```

### Better Auth Plugins (User-Managed)

Better Auth plugins are configured by the user in their `betterAuth()` call — **Arc does not need to enable them**. Users add any combination of plugins they need:

```typescript
import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { magicLink } from 'better-auth/plugins/magic-link';
import { phoneNumber } from 'better-auth/plugins/phone-number';
import { passkey } from 'better-auth/plugins/passkey';
import { apiKey } from 'better-auth/plugins/api-key';
import { organization } from 'better-auth/plugins/organization';
import { bearer } from 'better-auth/plugins/bearer';

const auth = betterAuth({
  database: mongodbAdapter(db),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: { clientId, clientSecret },
  },
  plugins: [
    organization({ teams: { enabled: true } }),
    bearer(),        // Bearer token support (for API/test usage)
    twoFactor(),     // TOTP, SMS, backup codes
    magicLink(),     // Email magic links
    phoneNumber(),   // Phone number auth
    passkey(),       // WebAuthn/FIDO2 passkeys
    apiKey(),        // API key generation & validation
  ],
});
```

Arc's adapter passes **all** Better Auth endpoints through to Fastify. Any plugin that adds endpoints (e.g. `/api/auth/two-factor/enable`) is automatically available — Arc does not filter or block any routes.

**Client-side plugins** mirror the server-side ones:

```typescript
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { organizationClient } from 'better-auth/client/plugins';

const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  plugins: [twoFactorClient(), organizationClient()],
});
```

### API Key Plugin

Better Auth's `apiKey()` plugin provides API key lifecycle management:

```typescript
// Server — enable the plugin
plugins: [apiKey({
  defaultPrefix: 'sk_',
  defaultKeyLength: 64,
  rateLimit: { enabled: true, timeWindow: 86400000, maxRequests: 1000 },
  enableMetadata: true,
})]

// Client — create/manage keys
const { key } = await authClient.apiKey.create({ name: 'Production', expiresIn: 90 });
const result = await authClient.apiKey.verify({ key: 'sk_...' });
const keys = await authClient.apiKey.list();
await authClient.apiKey.delete({ keyId: '...' });
```

**Org-scoped API keys:** Not yet natively supported (keys are user-scoped via `userId`). A draft PR exists to add `referenceId` + `references` fields for org ownership. Workaround: store `organizationId` in the key's `metadata` field and validate manually.

### Secondary Storage (Redis)

Better Auth supports Redis (or any KV store) as secondary storage for sessions and rate limits. This is configured in the user's `betterAuth()` call:

```typescript
import { betterAuth } from 'better-auth';
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const auth = betterAuth({
  database: mongodbAdapter(db),
  secondaryStorage: {
    get: (key) => redis.get(key),
    set: (key, value, ttl) => ttl ? redis.setEx(key, ttl, value) : redis.set(key, value),
    delete: (key) => redis.del(key),
  },
  session: {
    storeSessionInDatabase: true,  // Also persist to DB (optional)
    cookieCache: { enabled: true, maxAge: 300 },  // 5-min client-side cache
  },
});
```

**With secondary storage:**
- Sessions are stored in Redis (fast reads, auto-expiry)
- Rate limiting uses Redis counters
- Set `storeSessionInDatabase: true` to also persist sessions to MongoDB for durability

### Microservice Gateway Pattern

For microservice architectures, run Better Auth in a single API gateway. Other services verify sessions via trusted headers:

```
┌─────────────┐     cookies     ┌──────────────────┐
│  Frontend   │◄───────────────►│  API Gateway     │
│  (Next.js)  │                 │  (Arc + BA)      │
└─────────────┘                 │  Verifies session │
                                │  Forwards headers │
                                └───────┬──────────┘
                          X-User-Id     │    X-Org-Id
                          X-User-Roles  │
                    ┌───────────┬───────┴───────┐
                    │           │               │
              ┌─────▼─────┐ ┌──▼────────┐ ┌───▼──────┐
              │  Billing  │ │  Uploads  │ │  Notify  │
              │  Service  │ │  Service  │ │  Service │
              └───────────┘ └───────────┘ └──────────┘
```

**Gateway setup:**

```typescript
// API Gateway — Arc + Better Auth
const betterAuthAdapter = createBetterAuthAdapter({ auth, orgContext: true });
const app = await createApp({ auth: { betterAuth: betterAuthAdapter } });

// After auth, forward user context via trusted headers to internal services
app.addHook('onSend', async (request, reply) => {
  if (request.user) {
    // Internal services read these headers (trusted network only)
    request.headers['x-user-id'] = request.user.id;
    request.headers['x-user-roles'] = JSON.stringify(request.user.roles);
    request.headers['x-org-id'] = request.organizationId;
    request.headers['x-team-id'] = request.teamId;
  }
});
```

**Downstream microservice — no Better Auth needed:**

```typescript
// Billing service — trusts headers from API gateway
const app = await createApp({
  auth: {
    authenticate: async (request) => {
      const userId = request.headers['x-user-id'];
      if (!userId) return null;
      return {
        id: userId,
        roles: JSON.parse(request.headers['x-user-roles'] || '[]'),
      };
    },
  },
});
```

## Strategy 3: Bring Your Own Auth

Arc is auth-agnostic. You can plug in any auth system:

```typescript
// Custom Fastify plugin (Passport, Clerk, Auth0, etc.)
const app = await createApp({ auth: { plugin: myPassportPlugin } });

// Or just a custom authenticate function
const app = await createApp({
  auth: {
    authenticate: async (request) => {
      // Verify Clerk JWT, Auth0 token, API key, etc.
      const token = request.headers.authorization?.split(' ')[1];
      return await verifyWithClerk(token);
    },
  },
});

// Or disable auth entirely
const app = await createApp({ auth: false });
```

## Fastify Decorators

JWT auth decorates all three: `authenticate`, `optionalAuthenticate`, `authorize`. Better Auth only decorates `authenticate` — it does not provide `optionalAuthenticate` or `authorize`.

All JWT auth decorators:

### fastify.authenticate

PreHandler middleware — verifies JWT/session, sets `request.user`:

```typescript
fastify.get('/profile', {
  preHandler: [fastify.authenticate],
  handler: async (request) => ({ user: request.user }),
});
```

### fastify.optionalAuthenticate

PreHandler middleware — parses token if present but does NOT fail if missing/invalid. Sets `request.user` if valid, `null` otherwise. Used internally for public routes that still benefit from user context:

```typescript
fastify.get('/products', {
  preHandler: [fastify.optionalAuthenticate],
  handler: async (request) => {
    // request.user is populated if token was valid, null otherwise
    const user = request.user;  // UserBase | null
  },
});
```

**Note:** Only available with JWT auth strategy, not Better Auth.

### fastify.authorize(...roles)

Role-based middleware factory — checks `user.roles`:

```typescript
fastify.post('/admin', {
  preHandler: [fastify.authenticate, fastify.authorize('admin', 'superadmin')],
  handler: async (request) => { /* only admin/superadmin */ },
});

// Special: authorize('*') means any authenticated user (no role check)
```

## Resource Permissions

Function-based, not string arrays:

```typescript
import { defineResource, allowPublic, requireAuth, requireRoles } from '@classytic/arc';

defineResource({
  name: 'product',
  permissions: {
    list: allowPublic(),                      // No auth
    get: allowPublic(),
    create: requireRoles(['admin', 'editor']),
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
});
```

| Function | Description |
|----------|-------------|
| `allowPublic()` | No authentication required |
| `requireAuth()` | Any authenticated user |
| `requireRoles(['admin', 'editor'])` | User has at least one of these roles |
| `requireOwnership('userId', { bypassRoles })` | Only resource owner (or bypass) |
| `requireOrgMembership()` | Must be member of active org |
| `requireOrgRole('admin', 'owner')` | Must have specific org-level role |
| `requireTeamMembership()` | Must have active team in active org |
| `denyAll(reason?)` | Always deny |
| `allOf(perm1, perm2)` | AND — all must pass |
| `anyOf(perm1, perm2)` | OR — at least one must pass |
| `when(condition)` | Conditional — returns PermissionCheck |

**Custom permissions** — any function matching `PermissionCheck`:

```typescript
import type { PermissionCheck } from '@classytic/arc/permissions';

const requirePro = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return { granted: false, reason: 'Auth required' };
  if (ctx.user.plan !== 'pro') return { granted: false, reason: 'Pro plan required' };
  return { granted: true };
};

// Use like built-ins
defineResource({
  permissions: {
    create: requirePro(),
    update: anyOf(requirePro(), requireRoles(['admin'])),  // Mix custom + built-in
  },
});
```

## Organization-Based Roles

### Two Role Layers

| Layer | Storage | Field | Values | Checked By |
|-------|---------|-------|--------|------------|
| **Platform roles** | `user` collection | `user.roles[]` | `['user']`, `['admin']`, `['superadmin']` | `requireRoles()`, `authorize()` |
| **Org roles** | `member` collection | `member.role` | `'owner'`, `'admin'`, `'member'` | `requireOrgRole()`, `requireOrgMembership()` |

Platform roles are set in `user.additionalFields` with `input: false` (cannot be set during sign-up). Default: `['user']`. Superadmin bypasses all org-level checks.

### Org Guard Middleware

For routes that require org context, use `orgGuard()` and its shorthands:

```typescript
import { orgGuard, requireOrg, requireOrgRole } from '@classytic/arc/org';

// Require any org context (x-organization-id header must be set)
fastify.get('/invoices', {
  preHandler: [fastify.authenticate, requireOrg()],
  handler: async (request) => {
    // request.context.organizationId is guaranteed
  },
});

// Require specific org-level roles
fastify.post('/invoices', {
  preHandler: [fastify.authenticate, requireOrgRole('admin', 'accountant')],
  handler: async (request) => {
    // User must have 'admin' or 'accountant' role within the org
  },
});

// Full options
fastify.delete('/invoices/:id', {
  preHandler: [fastify.authenticate, orgGuard({
    requireOrgContext: true,       // Require org header (default: true)
    roles: ['admin'],             // Required org-level roles
    allowGlobal: false,           // Allow superadmin without org context
  })],
  handler: async (request) => { ... },
});
```

**Superadmin bypass:** Users with `roles: ['superadmin']` automatically bypass org role checks. When `allowGlobal: true`, they can also bypass the org context requirement entirely.

### Org-Scoped Resources

Combine `multiTenant` preset with org permissions:

```typescript
defineResource({
  name: 'invoice',
  organizationScoped: true,
  presets: [
    { name: 'multiTenant', tenantField: 'organizationId' },
    { name: 'ownedByUser', ownerField: 'createdBy' },
  ],
  permissions: {
    list: requireAuth(),           // multiTenant auto-filters by org
    get: requireAuth(),
    create: requireAuth(),         // multiTenant auto-injects orgId
    update: requireAuth(),         // ownedByUser checks createdBy
    delete: requireRoles(['admin']),
  },
});

// Requests require x-organization-id header
// GET /invoices → auto-filtered: { organizationId: 'org-123' }
// POST /invoices → auto-injects: { organizationId: 'org-123' }
```

### Organization Module (Full CRUD)

```typescript
import { organizationPlugin, orgScopePlugin } from '@classytic/arc/org';

// Full org CRUD + membership management
await fastify.register(organizationPlugin, { adapter: mongoOrgAdapter });
// Routes: POST/GET /api/organizations, GET/PATCH/DELETE /orgs/:orgId
// Members: GET/POST /orgs/:orgId/members, PATCH/DELETE /orgs/:orgId/members/:userId

// Auto-scope all queries by organizationId
await fastify.register(orgScopePlugin);
// Reads x-organization-id header → sets request.organizationId
```

## Request Type Definitions

Arc provides full TypeScript typings for auth context on `FastifyRequest`:

```typescript
// Augmented by Arc — available in all route handlers
interface FastifyRequest {
  user?: UserBase;           // Authenticated user (set by authenticate middleware)
  organizationId?: string;   // Active org ID (from Better Auth or x-organization-id header)
  teamId?: string;           // Active team ID (from Better Auth session)
  context?: {
    organizationId?: string;
    teamId?: string;
    orgRoles?: string[];     // ['owner', 'admin', 'member']
    orgScope?: string;       // 'bypass' | 'member' | 'public'
    [key: string]: unknown;
  };
}
```

## User Structure

Arc preserves your user shape — no normalization:

```typescript
interface UserBase {
  _id?: string;                     // MongoDB
  id?: string;                      // PostgreSQL
  roles?: string[];                 // Global roles (e.g. ['admin', 'user'])
  organizations?: Array<{           // Org memberships (JWT strategy)
    organizationId: string;
    roles?: string[];               // Org-level roles (e.g. ['owner', 'member'])
  }>;
  // ...any custom fields
}
```

With Better Auth + orgContext, org roles come from `request.context.orgRoles` instead of the JWT payload.

## Error Responses

| Status | Condition |
|--------|-----------|
| 401 | Missing/invalid/expired token or session |
| 403 | Valid auth but insufficient roles (`authorize`, `orgGuard`) |

**Org guard error codes:**
- `ORG_CONTEXT_REQUIRED` — Missing `x-organization-id` header
- `ORG_ROLE_REQUIRED` — User lacks required org-level role

## Configuration Reference

```typescript
interface AuthPluginOptions {
  jwt?: {
    secret: string;                // JWT secret (required, 32+ chars)
    expiresIn?: string;            // Access token TTL (default: '15m')
    refreshSecret?: string;        // Separate refresh secret (defaults to main secret)
    refreshExpiresIn?: string;     // Refresh token TTL (default: '7d')
    sign?: Record<string, unknown>;   // Extra @fastify/jwt sign options
    verify?: Record<string, unknown>; // Extra @fastify/jwt verify options
  };
  authenticate?: (request, { jwt, fastify }) => User | null;  // Custom authenticator
  onFailure?: (request, reply, error) => void;  // Custom auth error handler
  userProperty?: string;           // Request property name (default: 'user')
}
```

## Migration: @fastify/jwt v9 → v10

No code changes needed for standard `secret` + `expiresIn` usage. Renamed options (only if you use these directly):

| v9 (jsonwebtoken) | v10 (fast-jwt) |
|---|---|
| `audience` | `aud` (sign) / `allowedAud` (verify) |
| `issuer` | `iss` (sign) / `allowedIss` (verify) |
| `subject` | `sub` (sign) / `allowedSub` (verify) |
| `jwtid` | `jti` (sign) / `allowedJti` (verify) |
