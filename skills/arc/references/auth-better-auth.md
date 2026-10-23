# Better Auth adapter

Bridge Better Auth (BA) sessions into `request.scope`. Pass a real `betterAuth()` instance: arc calls `auth.api.*` in-process.

```typescript
import { createApp } from '@classytic/arc/factory';
import { createBetterAuthAdapter } from '@classytic/arc/auth';

const adapter = createBetterAuthAdapter({
  auth,                    // betterAuth() instance
  basePath: '/api/auth',   // default
  orgContext: true,        // resolve org membership into scope
});

const app = await createApp({ auth: { type: 'betterAuth', betterAuth: adapter } });
```

BA's Mongo adapter needs an open connection. Pass a thunk, resolved after `beforeBoot`:

```typescript
const app = await createApp({
  beforeBoot: () => connectDatabase(),
  auth: { type: 'betterAuth', betterAuth: () => createBetterAuthAdapter({ auth: getAuth(), orgContext: true }) },
});
```

Result also exposes `plugin`, `authenticate`, `optionalAuthenticate`, `permissions` (`requireOrgRole`, `requireOrgMembership`, `requireTeamMembership`), `openapi`.

## Options

| Option | Purpose |
|---|---|
| `orgContext` | Resolve org membership into scope (default false) |
| `resolveOrgRoles({ userId, organizationId, memberRoles })` | Org hierarchy seam: return the effective roles (e.g. parent-org roles) or `null` to stay non-member. Needs `orgContext` |
| `memberLookup: 'better-auth' \| 'resolver'` | `'resolver'` skips BA's membership read; use only if the resolver never reads `memberRoles` |
| `credentials: { Scheme: verify }` | Non-session credentials by `Authorization` scheme; verifier returns a `RequestScope` (usually `service`) or `null` (401). `Bearer` is reserved |
| `rateLimit: { max, timeWindow } \| false` | Per-route limit on the auth catch-all (no default) |
| `openapi` | `true` (default) extracts from `auth.api`; `false`; or a manual spec |
| `userFields` | Extra user fields merged into OpenAPI schemas |
| `exposeAuthErrors` | Show detail in 401 (debug only) |

```typescript
createBetterAuthAdapter({
  auth, orgContext: true,
  credentials: { Device: async (value, request) => verifyDevice(value) },   // Authorization: Device <token>
});
```

Gate `credentials` routes with `requireServiceScope(...)`.

## Org context flow (`orgContext: true`)

1. `auth.api.getSession()` in-process.
2. Org id = `session.activeOrganizationId`, else the `x-organization-id` header (API-key sessions carry no org).
3. Membership via `auth.api.getActiveMember` (or `getActiveMemberRole` for header orgs).
4. Roles split on comma: `"admin,recruiter"` => `['admin', 'recruiter']`.
5. `session.activeTeamId` is bound only if it appears in `auth.api.listUserTeams` for the ACTIVE org. Stale or cross-org teams are dropped. Needs better-auth >=1.7.0.
6. Scope: `{ kind: 'member', organizationId, orgRoles, teamId? }`.

`authenticate` and `optionalAuthenticate` run the same flow. Without an org the scope is `authenticated`.

## Multi-role members

BA stores several roles in one `member.role` string. Arc reads `scope.orgRoles` as an array and `requireOrgRole('admin')` matches any element. Querying `?role=admin` does NOT match a multi-role row (opaque text); use `role[like]=admin`.

## Sessions at scale

- Redis sessions: BA `secondaryStorage` (sessions skip the DB unless `session.storeSessionInDatabase: true`). Arc's `RedisSessionStore` (`@classytic/arc/auth/redis`) belongs to `createSessionManager`, a different layer. Do not mix.
- BA `session.cookieCache` never caches custom session fields such as `activeOrganizationId`, so scope cannot go stale, but the org lookup still runs.
- BA has its own limiter (`rateLimit.storage: 'secondary-storage'`). Exempt it from arc's bucket: `rateLimit: { skipPaths: ['/api/auth/*'] }`.

## Bearer transport (SPA, mobile)

Add BA `bearer()` (import from `better-auth/plugins/bearer`) so sessions travel as `Authorization: Bearer <session-token>`. Same `getSession()` path; no arc config change. Cookie and bearer can both be enabled.

## Scaffold

`arc init my-api --better-auth --mongokit --ts` prompts for session strategy (cookie, bearer, both) and the API key plugin, then wires plugins, `registerBetterAuthStubs`, and peer deps.
