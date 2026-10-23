# MCP: authentication modes

`auth` on `mcpPlugin` is one of: `false`, a Better Auth instance (OAuth 2.1), or an `McpAuthResolver`. A resolver returns `McpAuthResult` to allow or `null` to reject (401).

## 1. No auth (dev, stdio)

```typescript
await app.register(mcpPlugin, { resources, auth: false });
```

`ctx.user` is null and scope kind is `public`; guards like `!!ctx.user` still block. DNS rebinding protection defaults on.

## 2. Better Auth OAuth 2.1 (production SaaS)

```typescript
// auth config
import { mcp } from 'better-auth/plugins/mcp';
betterAuth({ plugins: [mcp({ loginPage: '/login' })] });

// app
await app.register(mcpPlugin, { resources, auth: getAuth() });
```

Arc registers `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` (forwarded to Better Auth). Each request resolves identity with `auth.api.getMcpSession({ headers })` (`userId`, `activeOrganizationId`).

## 3. Better Auth API key (machine clients)

```typescript
import { createMcpAuthFromBetterAuthApiKey } from '@classytic/arc/mcp';

await app.register(mcpPlugin, {
  resources,
  auth: createMcpAuthFromBetterAuthApiKey(getAuth(), {
    orgFromMetadata: true,        // true (default) | false | (metadata, key) => string | undefined
    metadataOrgField: 'tenantId', // default 'organizationId'
    permissionScope: 'mcp',       // key.permissions[scope] becomes scopes; false disables
  }),
});
```

- Requires the `apiKey()` plugin (`auth.api.verifyApiKey`), else throws at creation.
- Header order: `Authorization: Bearer <key>`, then `x-api-key`.
- User binding falls back `userId` then `referenceId`; a key with neither is a service principal (`clientId = key.id`).
- Disabled, expired or failing keys return null (fail closed).

## 4. Custom resolver

```typescript
auth: async (headers) => {
  const token = headers['authorization']?.replace('Bearer ', '');
  if (!token) return null;
  const p = await verifyJwt(token);
  return p ? { userId: p.sub, organizationId: p.org, roles: p.roles, orgRoles: p.orgRoles } : null;
},
```

`McpAuthResult` fields:

| Field | Use |
|---|---|
| `userId` | Human id; optional for machine principals |
| `organizationId` | Tenant scope |
| `roles`, `orgRoles` | Read by `requireRole()` and permission checks |
| `clientId` | Present: scope kind `service`, `ctx.user` is null |
| `scopes` | OAuth scopes carried on the service scope |
| `teamId` | Carried on `member` scope |
| `context` | `Record<string, string>` custom scope dimensions (`branchId`, ...). Resources gated with `requireScopeContext()` deny until supplied |

```typescript
// Service principal
auth: async (h) => h['x-service-key'] === process.env.SVC_KEY
  ? { clientId: 'ingestion', organizationId: 'org-123', scopes: ['write:events'] }
  : null,
```

## Tenancy

`organizationId` becomes the request scope (`member`, or `service` with `clientId`); the controller adds the tenant filter to every query, same as REST. Resources with `tenantField: false` are visible to all authenticated callers.

## Gotchas

- Resolver results are cached `authCacheTtlMs` (5 s) keyed by a hash of `authorization`/`x-api-key`; revocation lags by that window.
- `auth: false` exposes every generated tool anonymously; combine with `expose` and permissions.
