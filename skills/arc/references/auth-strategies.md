# Auth strategies

Pick how requests are authenticated. Every strategy ends the same way: `request.scope` is set (see multi-tenancy.md).

## Decision table

| User data lives | Written by | Use |
|---|---|---|
| Your DB | You | `type: 'jwt'` (arc issues/verifies) or `type: 'authenticator'` |
| Provider cloud (Clerk, Auth0, Supabase) | Provider | `authenticate` callback: verify provider token, set `request.scope` |
| Your DB | Better Auth | `type: 'betterAuth'` (auth-better-auth.md) |
| Upstream gateway | Gateway | `type: 'authenticator'` trusting forwarded headers |

Arc ships no per-provider code. The contract is `request.scope`.

## `type: 'jwt'`

```typescript
import { createApp } from '@classytic/arc/factory';

const app = await createApp({
  auth: {
    type: 'jwt',
    jwt: {
      secret: process.env.JWT_SECRET!,            // 32+ chars
      expiresIn: '15m',
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      refreshExpiresIn: '7d',
    },
    // Optional: replaces the default Bearer verify
    authenticate: async (request, { jwt }) => {
      const token = request.headers.authorization?.split(' ')[1];
      if (!token || !jwt) return null;            // null = 401
      const decoded = jwt.verify<{ _id: string }>(token);
      return userRepo.getById(decoded._id);
    },
    tokenExtractor: (req) => req.cookies?.['auth-token'] ?? null,
    isRevoked: async (decoded) => Boolean(await redis.sismember('revoked', String(decoded.jti))),
  },
});
```

Decorates `app.authenticate`, `app.optionalAuthenticate`, `app.authorize(...roles)` (`'*'` = any authenticated user), `app.auth`.

```typescript
const tokens = app.auth.issueTokens({ _id: user._id, email, role });
// { accessToken, refreshToken?, expiresIn, tokenType: 'Bearer' }
const decoded = app.auth.verifyRefreshToken(refreshToken);   // rejects access tokens
```

Gotchas:
- Default verify requires `type: 'access'` in the token (`issueTokens` sets it). Tokens without it are 401 unless `strictTokenType: false`. Refresh tokens are always rejected.
- `isRevoked` fails closed: a throw means revoked.
- Default scope from the returned user: has `organizationId` => `member`, else `authenticated`. A scope your `authenticate` already set is kept.
- 401 body is generic; `exposeAuthErrors: true` shows the message (debug only).

## `type: 'authenticator'`

```typescript
auth: {
  type: 'authenticator',
  authenticate: async (req, reply) => {
    const session = await validateSession(req);
    if (!session) return reply.code(401).send({ code: 'arc.unauthorized', message: 'Unauthorized', status: 401 });
    req.user = session.user;
  },
  // optionalAuthenticate: optional; derived from authenticate when omitted
}
```

## `type: 'custom'` and `auth: false`

```typescript
auth: { type: 'custom', plugin: myAuthPlugin }   // plugin must decorate fastify.authenticate
auth: false                                      // no auth
```

## Cloud provider (Clerk, Auth0, Supabase)

No tables to overlay. Verify the provider token, map claims to scope.

```typescript
import { verifyToken } from '@clerk/backend';

auth: {
  type: 'jwt',
  jwt: { secret: process.env.JWT_SECRET! },       // required by the type, unused by authenticate
  authenticate: async (request) => {
    const token = request.headers.authorization?.slice(7);
    if (!token) return null;
    const claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
    if (claims.org_id) {
      request.scope = {
        kind: 'member', userId: claims.sub, userRoles: [],
        organizationId: claims.org_id, orgRoles: claims.org_role ? [claims.org_role] : [],
      };
    }
    return { id: claims.sub, email: claims.email };
  },
}
```

Need joins on users? Webhook-sync the provider's users into a local collection and expose it as a normal resource.

## Gateway headers

```typescript
auth: {
  type: 'authenticator',
  authenticate: async (req, reply) => {
    const userId = req.headers['x-user-id'];
    if (typeof userId !== 'string') return reply.code(401).send({ code: 'arc.unauthorized', message: 'Unauthorized', status: 401 });
    req.user = { id: userId, role: JSON.parse(String(req.headers['x-user-roles'] ?? '[]')) };
  },
}
```

Trust these headers only when the service is unreachable except through the gateway.

## Header-selected org (JWT/custom auth)

`resolveOrgFromHeader` from `@classytic/arc/scope` is a `preHandler` that upgrades the scope to `member` from `x-organization-id` after your `resolveMembership(userId, orgId)` returns `{ roles }` (or null). Register it after authentication.
