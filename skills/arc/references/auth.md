# Arc Authentication & Authorization

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
1. Gets session via Better Auth
2. Reads `session.activeOrganizationId`, or falls back to `x-organization-id` header (needed for API key auth where synthetic sessions have no org context)
3. Looks up org membership via `getActiveMemberRole` (with explicit `organizationId` param for header-based resolution)
4. Splits roles: `"admin,recruiter"` → `['admin', 'recruiter']`
5. Sets `request.scope`: `{ kind: 'member', organizationId, orgRoles: string[], teamId? }`

### API Key Auth (Better Auth `apiKey()` plugin)

When the `apiKey()` plugin is enabled in Better Auth, Arc's adapter automatically:
- Resolves API key sessions via `enableSessionForAPIKeys: true`
- Falls back to `x-organization-id` header for org context (API key sessions have no `activeOrganizationId`)
- Generates OpenAPI security schemes dynamically — `apiKeyAuth` only appears in the spec when the plugin is active

```
x-api-key: ak_live_...           # Authentication
x-organization-id: org_abc123    # Org context (required for org-scoped resources)
```

**OpenAPI security semantics:**
- Resource paths: `security: [{ bearerAuth: [] }, { apiKeyAuth: [], orgHeader: [] }]`
  - Meaning: bearer token alone **OR** (API key **AND** org header together)
- Auth endpoints: `security: [{ cookieAuth: [] }, { bearerAuth: [] }, { apiKeyAuth: [] }]`
  - No org header required for auth management endpoints

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

// Variants:
// { kind: 'public' }
// { kind: 'authenticated' }
// { kind: 'member', organizationId, orgRoles: string[], teamId? }
// { kind: 'elevated', organizationId?, elevatedBy }
```

## Two Role Layers

| Layer | Source | Checked By |
|-------|--------|------------|
| Platform roles | `user.role` (`string \| string[]`) | `requireRoles()`, `authorize()` |
| Org roles | `request.scope.orgRoles` | `requireOrgRole()`, `requireOrgMembership()` |

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
