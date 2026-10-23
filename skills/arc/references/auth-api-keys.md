# API keys and machine identity

Two routes to machine callers: Better Auth `apiKey()` (keys stored by BA), or your own `authenticate` / permission check mapping any credential to a `service` scope. Both end in `RequestScope.service`.

## Better Auth `apiKey()`

`apiKey` is a SEPARATE package. It is not in `better-auth/plugins`.

```typescript
import { apiKey } from '@better-auth/api-key';

const auth = betterAuth({
  plugins: [organization(), apiKey({ enableSessionForAPIKeys: true })],   // option belongs to the plugin
});
```

```
x-api-key: ak_live_...           # authentication
x-organization-id: org_abc123    # org context for org-scoped resources
```

- API-key sessions have no `activeOrganizationId`. Without the header, `scope.kind` is `authenticated`, not `member`.
- OpenAPI security is derived automatically: resource paths `[{ bearerAuth }, { apiKeyAuth, orgHeader }]` (bearer alone OR key AND org header); auth endpoints `[{ cookieAuth }, { bearerAuth }, { apiKeyAuth }]`. `apiKeyAuth` appears only when the plugin is active.
- `apikey` rows use `referenceId` (not `userId`) and a required `configId`: remember in fixtures.

Admin read view of keys (the overlay is read-only; issue and revoke through BA `/api/auth/api-key/*`):

```typescript
const apiKeyAdapter = await createBetterAuthOverlay({ auth, mongoose, collection: 'apikey' });

defineResource({
  name: 'apikey',
  adapter: apiKeyAdapter,
  tenantField: false,
  permissions: { list: requireRoles(['admin']), get: requireRoles(['admin']) },
  fields: { key: fields.hidden() },      // never expose the raw key
});
```

## Service scope from `authenticate`

Arc's default JWT verify installs `member` scope. Custom authenticators are the extension point.

```typescript
auth: {
  type: 'jwt',
  jwt: { secret: process.env.JWT_SECRET! },
  authenticate: async (request, { jwt }) => {
    const token = request.headers.authorization?.slice(7);
    if (!token || !jwt) return null;
    const d = jwt.verify<{ clientId?: string; userId?: string; organizationId?: string; scopes?: string[] }>(token);
    if (d.clientId) {
      request.scope = { kind: 'service', clientId: d.clientId, organizationId: d.organizationId ?? '', scopes: d.scopes ?? [] };
      return { clientId: d.clientId };                 // becomes request.user
    }
    return userRepo.getById(String(d.userId));
  },
}
```

| Credential | Wire via |
|---|---|
| JWT with `clientId` claim | example above |
| API key in header (DB lookup) | read `x-api-key`, look up client, set service scope |
| Better Auth client credentials | `auth.api.getSession({ headers })`, detect the grant |
| mTLS | map certificate DN (terminator header) to `clientId` |
| OAuth2 client credentials | verify via introspection |
| Non-session scheme with BA | `createBetterAuthAdapter({ credentials })` |

An API-key permission check can also return the scope (`allow({ scope })`): see multi-tenancy.md.

## Gating services

```typescript
import { anyOf, requireOrgRole, requireServiceScope } from '@classytic/arc/permissions';

permissions: {
  create: requireServiceScope('orders:write'),                       // any listed scope; elevated passes
  update: anyOf(requireOrgRole('editor'), requireServiceScope('orders:write')),   // humans or services
}
```

- `requireOrgRole` DENIES service scopes. Compose with `anyOf` to accept both.
- `requireServiceScope` denies `member` scopes.

## Audit and rate limits

Audit rows use `userId`, else `clientId`, as actor (from the validated scope). Key rate limits per client so one agent cannot starve humans:

```typescript
import { createTenantKeyGenerator, getClientId, getOrgId, isService } from '@classytic/arc/scope';

rateLimit: {
  keyGenerator: createTenantKeyGenerator({
    strategy: ({ scope, ip }) =>
      scope && isService(scope) ? `svc:${getClientId(scope)}` : `org:${(scope && getOrgId(scope)) ?? ip}`,
  }),
}
```
