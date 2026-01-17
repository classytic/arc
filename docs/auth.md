# Auth Module

JWT authentication with role-based authorization.

## Setup

```typescript
import Fastify from 'fastify';
import { authPlugin } from '@classytic/arc/auth';

const fastify = Fastify();

await fastify.register(authPlugin, {
  secret: process.env.JWT_SECRET,
  expiresIn: '7d',
  refreshExpiresIn: '7d',
});
```

## Configuration

```typescript
interface AuthPluginOptions {
  secret?: string;      // JWT secret (default: env.JWT_SECRET)
  expiresIn?: string;   // Access token expiration (default: '7d')
  refreshSecret?: string; // Refresh token secret (default: secret)
  refreshExpiresIn?: string; // Refresh token expiration (default: '7d')
  userProperty?: string; // Request property name (default: 'user')
  superadminRoles?: string[]; // Bypass roles (default: ['superadmin'])
  decorate?: boolean; // Enable decorators (default: true)
}
```

## Decorators

The plugin decorates Fastify with:

### fastify.authenticate

Middleware that verifies JWT and sets `request.user`.

```typescript
fastify.get('/profile', {
  preHandler: [fastify.authenticate],
  handler: async (request) => {
    return { user: request.user };
  },
});
```

### fastify.authorize(...roles)

Middleware that checks user has required roles.

```typescript
fastify.post('/admin/action', {
  preHandler: [
    fastify.authenticate,
    fastify.authorize('admin', 'superadmin'),
  ],
  handler: async (request) => {
    // Only admins reach here
  },
});
```

### fastify.auth.issueTokens(payload)

Helper to issue access + refresh tokens with TTLs:

```typescript
const { token, refreshToken, expiresIn, refreshExpiresIn } = fastify.auth.issueTokens({
  id: user._id,
  roles: user.roles,
});
```

## Resource Permissions

Define permissions per CRUD operation:

```typescript
defineResource({
  name: 'product',
  permissions: {
    list: [],              // Public (no auth required)
    get: [],               // Public
    create: ['admin'],     // Requires admin role
    update: ['admin'],     // Requires admin role
    delete: ['superadmin'], // Requires superadmin role
  },
});
```

## User Object

Expected shape of `request.user`:

```typescript
interface User {
  _id?: string;
  id?: string;
  roles?: string[];
  organizations?: Array<{
    organizationId: string;
    roles?: string[];
  }>;
}
```

## Token Generation

Generate tokens for users:

```typescript
// In your auth routes
fastify.post('/login', async (request, reply) => {
  const { email, password } = request.body;
  const user = await authenticateUser(email, password);

  const tokens = fastify.auth.issueTokens({
    id: user._id,
    roles: user.roles,
    organizations: user.organizations,
  });

  return tokens;
});
```

## Error Responses

| Status | Condition |
|--------|-----------|
| 401 | Missing/invalid token |
| 403 | Valid token but insufficient roles |
