# Auth Module

JWT authentication with role-based permissions, powered by `@fastify/jwt` v10 (uses `fast-jwt` internally for high-performance token operations).

## Quick Start

```bash
npm install @fastify/jwt@^10.0.0
```

```typescript
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  preset: 'production',
  auth: {
    jwt: {
      secret: process.env.JWT_SECRET,
      expiresIn: '7d',
    },
  },
});

// Auth is now available: app.jwt, app.authenticate
```

> **Note:** Arc uses `@fastify/jwt` v10 which replaces `jsonwebtoken` with `fast-jwt`. The `secret` and `expiresIn` options are unchanged. If you pass sign/verify options directly, see the [migration notes](#migrating-from-fastifyjwt-v9-to-v10) below.

## Configuration

```typescript
interface AuthPluginOptions {
  jwt?: {
    secret: string;                    // JWT secret (required, 32+ chars)
    expiresIn?: string;                // Token expiration (default: '7d')
    refreshSecret?: string;            // Refresh token secret
    refreshExpiresIn?: string;         // Refresh expiration (default: '7d')
  };
  authenticate?: (request, helpers) => User | null; // Custom authenticator
  onFailure?: (request, reply, error) => void;      // Custom error handler
  userProperty?: string;               // Request property (default: 'user')
}
```

## User Object

Arc preserves your auth structure without normalization.

```typescript
interface UserBase {
  _id?: string;                        // User ID (MongoDB)
  id?: string;                         // User ID (PostgreSQL)
  roles?: string[];                    // User roles
  organizations?: Array<{              // Multi-tenant orgs
    organizationId: string;
    roles?: string[];
  }>;
  // ... any custom fields
}
```

**No role normalization** - Arc uses your exact user structure.

## Request Context

Authenticated user available in `req.user`:

```typescript
import type { IRequestContext, IControllerResponse } from '@classytic/arc';

class ProfileController extends BaseController {
  async getProfile(req: IRequestContext): Promise<IControllerResponse> {
    const { user } = req;

    if (!user) {
      return { success: false, error: 'Unauthorized', status: 401 };
    }

    const profile = await this.repository.findById(user._id);
    return { success: true, data: profile };
  }
}
```

## Permissions

Use permission functions (not string arrays):

```typescript
import { defineResource, allowPublic, requireAuth, requireRoles } from '@classytic/arc';

defineResource({
  name: 'product',
  permissions: {
    list: allowPublic(),                     // No auth required
    get: allowPublic(),                      // No auth required
    create: requireRoles(['admin', 'editor']), // Specific roles
    update: requireRoles(['admin']),
    delete: requireRoles(['admin']),
  },
});
```

### Permission Functions

| Function | Description |
|----------|-------------|
| `allowPublic()` | No authentication required |
| `requireAuth()` | Requires any authenticated user |
| `requireRoles(['admin', 'editor'])` | At least one role matches |
| `requireOwnership('userId', { bypassRoles })` | Only resource owner (or bypass) |
| `denyAll(reason?)` | Always deny |
| `allOf(check1, check2)` | AND — all must pass |
| `anyOf(check1, check2)` | OR — at least one must pass |
| `when(condition)` | Conditional — returns PermissionCheck |

### Custom Permission Functions

A `PermissionCheck` is any function `(ctx: PermissionContext) => boolean | { granted, reason?, filters? }`:

```typescript
import type { PermissionCheck } from '@classytic/arc/permissions';

const requirePremium = (): PermissionCheck => async (ctx) => {
  if (!ctx.user) return { granted: false, reason: 'Unauthorized' };
  if (!ctx.user.isPremium) return { granted: false, reason: 'Premium required' };
  return { granted: true };
};

// Use like built-ins
defineResource({
  permissions: {
    create: requirePremium(),
  },
});
```

## Token Generation

Generate tokens for users:

```typescript
// In your login route
app.post('/login', async (request, reply) => {
  const { email, password } = request.body;

  // Authenticate user
  const user = await authenticateUser(email, password);
  if (!user) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  // Issue tokens
  const tokens = app.auth.issueTokens({
    _id: user._id,
    email: user.email,
    roles: user.roles,
    organizations: user.organizations,
  });

  return reply.send(tokens);
});
```

**Response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 604800,
  "refreshExpiresIn": 604800
}
```

## Manual Setup (Without Factory)

```typescript
import Fastify from 'fastify';
import { authPlugin } from '@classytic/arc/auth';

const fastify = Fastify();

await fastify.register(authPlugin, {
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: '7d',
  },
});

// Use in routes
fastify.get('/profile', {
  preHandler: [fastify.authenticate],
  handler: async (request, reply) => {
    return { user: request.user };
  },
});

// Role-based auth
fastify.post('/admin/action', {
  preHandler: [
    fastify.authenticate,
    fastify.authorize('admin'),
  ],
  handler: async (request, reply) => {
    // Only admins reach here
  },
});
```

## Decorators

The auth plugin adds these to Fastify:

### fastify.authenticate

Middleware that verifies JWT and sets `request.user`.

```typescript
fastify.get('/protected', {
  preHandler: [fastify.authenticate],
  handler: async (request) => {
    console.log(request.user); // Authenticated user
  },
});
```

### fastify.authorize(...roles)

Middleware that checks user has required roles.

```typescript
fastify.post('/admin', {
  preHandler: [
    fastify.authenticate,
    fastify.authorize('admin', 'superadmin'),
  ],
  handler: async (request) => {
    // Only admin or superadmin
  },
});
```

### fastify.auth.issueTokens(payload)

Helper to issue access + refresh tokens.

```typescript
const tokens = fastify.auth.issueTokens({
  _id: user._id,
  email: user.email,
  roles: user.roles,
});
```

## Multi-Tenant Auth

For SaaS apps with organization-scoped access:

```typescript
// User structure with organizations
const user = {
  _id: 'user-123',
  email: 'user@example.com',
  roles: ['user'],
  organizations: [
    { organizationId: 'org-1', roles: ['member'] },
    { organizationId: 'org-2', roles: ['admin'] },
  ],
};

// Issue token with org data
const tokens = app.auth.issueTokens(user);

// In controller, access org from request
class OrderController extends BaseController {
  async list(req: IRequestContext): Promise<IControllerResponse> {
    const { user, organizationId } = req;

    // Verify user has access to org
    const hasAccess = user?.organizations?.some(
      (org) => org.organizationId === organizationId
    );

    if (!hasAccess) {
      return { success: false, error: 'Forbidden', status: 403 };
    }

    // Query scoped to org
    const orders = await this.repository.findAll({
      filter: { organizationId },
    });

    return { success: true, data: orders };
  }
}
```

See [Org Module](./org.md) for automatic organization scoping.

## Error Responses

| Status | Condition |
|--------|-----------|
| 401 | Missing/invalid token |
| 403 | Valid token but insufficient roles |

## Disabling Auth

If you don't need Arc's auth:

```typescript
const app = await createApp({
  auth: false, // Disable Arc auth
  // Use your own auth plugin
});
```

## Custom Authentication

Replace Arc's auth with your own:

```typescript
import { createApp } from '@classytic/arc/factory';
import { oauthPlugin } from './auth/oauth.js';

const app = await createApp({
  auth: false, // Disable Arc auth
});

// Register custom auth
await app.register(oauthPlugin);

// Use Arc permissions with custom auth
defineResource({
  permissions: {
    create: requireAuth(), // Works with custom auth
  },
});
```

## Best Practices

1. **Use strong secrets** - Minimum 32 characters for JWT secrets
2. **Short token expiry** - Use refresh tokens for long sessions
3. **Store refresh tokens securely** - HttpOnly cookies or secure storage
4. **Validate on every request** - Don't cache auth checks
5. **Use HTTPS in production** - Required for secure token transmission
6. **Rotate secrets periodically** - Update JWT secrets regularly

## Migrating from @fastify/jwt v9 to v10

Arc v2.0 requires `@fastify/jwt` v10, which replaces `jsonwebtoken` with `fast-jwt` internally.

**What changed:**
- Library switch: `jsonwebtoken` → `fast-jwt` (faster, maintained)
- Some sign/verify option names were renamed:

| v9 (jsonwebtoken) | v10 (fast-jwt) |
|---|---|
| `audience` | `aud` (sign) / `allowedAud` (verify) |
| `issuer` | `iss` (sign) / `allowedIss` (verify) |
| `subject` | `sub` (sign) / `allowedSub` (verify) |
| `jwtid` | `jti` (sign) / `allowedJti` (verify) |

**What didn't change:**
- `secret` — unchanged
- `expiresIn` — unchanged
- `sign()` / `verify()` / `decode()` API — same interface
- Token format — same JWT output, fully compatible

**Impact on most Arc apps: None.** If you only use `secret` + `expiresIn` (the standard pattern), no code changes are needed.

```bash
# Upgrade
npm install @fastify/jwt@^10.0.0
```

## See Also

- [Permissions Module](./permissions.md) - Advanced permission patterns
- [Org Module](./org.md) - Multi-tenant organization scoping
- [Core Module](./core.md) - Request context and controllers
