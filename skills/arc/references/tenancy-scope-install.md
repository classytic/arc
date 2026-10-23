# Installing request scope from custom auth

Pick where scope gets set. Arc reads `request.scope` and does not care how it got there.

| Your auth source | Where to set scope |
|---|---|
| Better Auth session | Nothing: the adapter with `orgContext: true` does it |
| JWT or authenticator, user has `organizationId` | Return the user from `authenticate()`: arc derives `member` |
| JWT with org chosen by header | `resolveOrgFromHeader` preHandler (auth-strategies.md) |
| API key with DB lookup | `allow({ scope })` from a permission check |
| Gateway-injected headers | `allow({ scope })` or an `onRequest` hook |
| Service account OAuth token | `allow({ scope })` with `kind: 'service'`, or `authenticate` |
| Platform admin | `createApp({ elevation })` => `kind: 'elevated'` |

## 1. Better Auth

```typescript
await createApp({ auth: { type: 'betterAuth', betterAuth: createBetterAuthAdapter({ auth, orgContext: true }) } });
```

## 2. Authenticator returning a user

```typescript
await createApp({
  auth: {
    type: 'authenticator',
    authenticate: async (request, reply) => {
      const user = await verifyJwt(request.headers.authorization);
      if (!user) return reply.code(401).send({ code: 'arc.unauthorized', message: 'Unauthorized', status: 401 });
      request.user = user;      // `organizationId` on the user => member scope
    },
  },
});
```

## 3. Scope from a permission check (API keys, service accounts)

```typescript
import { allow, deny, type PermissionCheck } from '@classytic/arc/permissions';

export function requireApiKey(): PermissionCheck {
  return async ({ request }) => {
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey !== 'string') return deny('Missing API key');
    const client = await clientRepo.getOne({ apiKey });
    if (!client) return deny('Invalid API key');

    return allow({
      scope: {
        kind: 'service',
        clientId: String(client._id),
        organizationId: String(client.companyId),
        scopes: client.allowedScopes,
      },
      ...(client.projectId ? { policy: { projectId: client.projectId } } : {}),   // extra row narrowing
    });
  };
}

defineResource({
  name: 'job',
  adapter,
  tenantField: 'companyId',
  permissions: { list: requireApiKey(), get: requireApiKey(), create: requireApiKey() },
});
```

No auth plugin, scope hook or tenant middleware needed; cross-tenant get/list/update/delete isolation is covered by `tests/e2e/permission-scope-wire.test.ts`.

Override safety: `allow({ scope })` installs scope only while the current scope is `public`. An already-authenticated request is never downgraded or overwritten.

## 4. Fastify hook

For mTLS or RPC callers, set `request.scope` in an `onRequest` hook.

## Mongokit plugin order

Mongokit validates plugin order on the repository you pass to `defineResource`: multi-tenant must precede cache, soft-delete must precede batch-operations. Set `pluginOrderChecks: 'throw'` in the `Repository` options (fourth constructor argument) in production. Arc does not surface this option.

```typescript
new Repository(Model, [multiTenantPlugin({ tenantField: 'organizationId' }), softDeletePlugin(), batchOperationsPlugin()], {}, { pluginOrderChecks: 'throw' });
```
