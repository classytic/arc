---
name: Multi-Tenancy Playbook
description: Where `tenantField` takes effect, how it composes with `_policyFilters`, and how to install scope from custom auth (API keys, service accounts, gateway headers)
---

# Multi-Tenancy Playbook

Arc's multi-tenancy has exactly **one source of truth**: `request.scope`. This document shows where it's read, how filters compose, and how to wire custom authentication strategies (API keys, service accounts) without fighting the framework.

## Mental model

Every request goes through this ladder — if any step is missed, tenant isolation silently breaks:

```
1. Authenticator populates request.scope   (member | service | elevated | ...)
                  ↓
2. Permission check validates access        (allowPublic | requireAuth | requireApiKey | ...)
                  ↓                          may ALSO set request.scope via PermissionResult.scope
3. fastifyAdapter snapshots scope into metadata._scope
                  ↓
4. QueryResolver / AccessControl read metadata._scope
                  ↓
5. If tenantField is set AND getOrgId(scope) returns an orgId,
   the org filter is ALWAYS prepended to the query
```

## The 5 scope kinds

| Kind            | Use case                            | Has `userId` | Has `organizationId` | Helper                   |
|-----------------|-------------------------------------|:------------:|:--------------------:|--------------------------|
| `public`        | No authentication                   | ❌           | ❌                    | `PUBLIC_SCOPE`           |
| `authenticated` | Logged-in user, no org context      | ✅           | ❌                    | `getUserId()`            |
| `member`        | User in an org with specific roles  | ✅           | ✅                    | `isMember()` + `getOrgId()` |
| `service`       | Machine-to-machine (API keys, bots) | ❌ (`clientId` instead) | ✅          | `isService()` + `getClientId()` |
| `elevated`      | Platform admin, explicit elevation  | ✅           | Optional             | `isElevated()`           |

**Why `service` is distinct from `member`:** a service account is not a human. It has no user record, no global roles, and should be auditable as a machine actor. Faking it as a `member` with `userId: client._id` pollutes audit logs, confuses rate-limit keys, and makes future per-service-scope authorization (OAuth scopes) harder.

## Where `tenantField` is read

Every resource defines `tenantField` (default: `'organizationId'`, or `false` to disable). It is read in **exactly three places** and ALL of them derive the org ID from `metadata._scope` via `getOrgId()`:

| File                           | Method                  | Purpose                                        |
|--------------------------------|-------------------------|------------------------------------------------|
| `src/core/QueryResolver.ts`    | `resolve()`             | `list` — prepends `{ [tenantField]: orgId }` to the filter |
| `src/core/AccessControl.ts`    | `buildIdFilter()`       | `get`, `update`, `delete` by ID — compound filter so cross-tenant IDs 404 |
| `src/core/BaseController.ts`   | `buildBulkFilter()`     | `bulkUpdate`, `bulkDelete` — narrows bulk ops to the caller's org |

**Everything else** (`BodySanitizer`, `MongoKit QueryParser`, presets) already composes cleanly with these three read points. If `getOrgId(scope)` returns the right value, you have tenant isolation — end of story.

## Filter composition

`_policyFilters` and `tenantField` are different and both apply:

```ts
// The final filter passed to the database is:
{
  ...parsedUserFilters,      // from the incoming query string
  ..._policyFilters,         // from permission checks (ownership, project scoping, etc.)
  [tenantField]: orgId,      // from metadata._scope (if tenantField is set and scope has orgId)
}
```

**Priority rules:**
- `_policyFilters` overrides user-supplied filters (the user can't bypass them)
- `tenantField` only gets injected if `_policyFilters` does not already set it (so a more specific policy filter wins)
- `elevated` scope with no `organizationId` means the filter is skipped entirely (admin sees everything)

## Four ways to install scope

### 1. Better Auth (recommended for human users)

The `betterAuth` adapter reads the session cookie and installs `kind: 'member'` automatically. Nothing to wire.

```ts
await createApp({
  auth: getAuth(),  // Better Auth instance
  // ... scope is set by the adapter, zero code
});
```

### 2. Custom Fastify authenticator (JWT, headers, whatever)

Arc's `authPlugin.ts` auto-derives scope from `request.user` after your authenticator returns. If your user has `organizationId`, you get a `member` scope for free:

```ts
await createApp({
  auth: {
    type: 'authenticator',
    authenticate: async (request) => {
      const user = await verifyJwt(request.headers.authorization);
      return user; // Must have `organizationId` for member scope
    },
  },
});
```

### 3. `PermissionResult.scope` (NEW — best for API keys, service accounts, custom headers)

Return the scope directly from your permission check. This is the cleanest integration point for machine-to-machine auth — no separate auth plugin, no scope-derivation-from-user magic. It's explicit, typed, and auditable.

```ts
// src/permissions/apiKey.ts
import type { PermissionCheck } from '@classytic/arc/permissions';
import { ClientModel } from '../models/Client.js';

export function requireApiKey(): PermissionCheck {
  return async ({ request }) => {
    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (!apiKey) return { granted: false, reason: 'Missing API key' };

    const client = await ClientModel.findOne({ apiKey });
    if (!client) return { granted: false, reason: 'Invalid API key' };

    return {
      granted: true,
      scope: {
        kind: 'service',
        clientId: String(client._id),
        organizationId: String(client.companyId),
        scopes: client.allowedScopes,  // optional OAuth-style scope strings
      },
      // Optional additional row-level narrowing
      filters: client.projectId ? { projectId: client.projectId } : undefined,
    };
  };
}
```

Then wire it into the resource:

```ts
defineResource({
  name: 'job',
  adapter: createMongooseAdapter({ model: Job, repository: jobRepo }),
  controller: new BaseController(jobRepo, { tenantField: 'companyId' }),
  permissions: {
    list: requireApiKey(),
    get: requireApiKey(),
    create: requireApiKey(),
    update: requireApiKey(),
    delete: requireApiKey(),
  },
});
```

**That's the whole setup.** No auth plugin, no scope-resolution hook, no separate tenant-filter middleware. One file, one function, full tenant isolation — verified against cross-tenant `get`, `list`, `update`, and `delete` in [tests/e2e/permission-scope-wire.test.ts](../../../tests/e2e/permission-scope-wire.test.ts).

**Override safety:** `PermissionResult.scope` only writes to `request.scope` when the current scope is still `public`. An already-authenticated request (from Better Auth, JWT, etc.) is never downgraded or overwritten.

### 4. Custom Fastify hook (advanced)

For exotic cases (mTLS, downstream RPC calls), write an `onRequest` hook that sets `request.scope` directly. Arc reads from `request.scope` — it doesn't care how you got there.

## Decision table

| Your auth source                  | Where to set scope                                  |
|-----------------------------------|------------------------------------------------------|
| Better Auth session cookie        | Nothing — `betterAuth` adapter handles it            |
| JWT with `organizationId` claim   | Return it from `authenticate()` — auth plugin derives scope |
| API key → DB lookup               | **`PermissionResult.scope`** ← the clean path        |
| Gateway-injected headers          | `PermissionResult.scope` or a custom `onRequest` hook |
| Service account OAuth token       | `PermissionResult.scope` with `kind: 'service'`      |
| Platform admin elevation          | `elevationPlugin` — sets `kind: 'elevated'`          |

## What happens when scope is missing

If `tenantField` is set but `getOrgId(scope)` returns `undefined`:

- **`list` / `get` / `update` / `delete`** — the filter is NOT narrowed. A caller with `public` scope would see ALL rows across ALL tenants. **This is why you must always pair `tenantField` with a permission check that installs a scope with `organizationId`.**
- **`bulkUpdate` / `bulkDelete`** — `buildBulkFilter()` returns `null` and the bulk operation is rejected. This is a safety net, but don't rely on it for `list`.

Arc does NOT auto-derive scope from `request.user.organizationId` — that's a footgun (silent tenant leak if you set the user but forget the scope). If you want this behavior, either use the JWT/custom authenticator path (which does derive automatically) or return `scope` explicitly from your permission check.

## Gotchas

1. **`tenantField` is per-resource, not per-app.** Different resources can use different tenant field names (`companyId`, `workspaceId`, `tenantId`). The org ID always comes from `getOrgId(scope)`.
2. **`elevated` with no `organizationId` bypasses tenant filtering.** This is intentional (admin sees everything), but it means you can't use `kind: 'elevated'` for normal per-org access.
3. **`systemManaged` is your seatbelt for create/update.** Mark tenant fields (`companyId`, `organizationId`) as `systemManaged` in `fieldRules` so `BodySanitizer` strips any client-supplied value. The tenant field is then injected from the scope at write time — not from the request body.
4. **Rate-limit keys respect all 5 scope kinds.** The built-in `createTenantKeyGenerator` uses `organizationId` for member/service/elevated and falls back to `userId`/IP for authenticated/public.
5. **multiTenant preset injects org on UPDATE (v2.9).** Body-supplied `organizationId` is overwritten with the caller's scope — closes the tenant-hop vector where a member could PATCH their own doc into another tenant. Elevated scope with no org still bypasses (admin cross-tenant).

## Mongokit tenant-context helper (optional)

If your adapter is mongokit ≥3.7, you can wire mongokit's `createTenantContext()` to propagate the org id through `AsyncLocalStorage` — useful when domain code outside arc routes needs the current tenant without threading `req` everywhere:

```ts
import { createTenantContext, multiTenantPlugin, Repository } from '@classytic/mongokit';
import { getOrgId } from '@classytic/arc/scope';

const tenantContext = createTenantContext();
const repo = new Repository(Model, [
  multiTenantPlugin({ tenantField: 'organizationId', context: tenantContext }),
]);

// Install scope → ALS bridge once in your app:
fastify.addHook('preHandler', (req, _reply, done) => {
  const scope = (req.metadata as { _scope?: unknown } | undefined)?._scope;
  const orgId = scope ? getOrgId(scope as never) : undefined;
  if (orgId) tenantContext.run(orgId, done);
  else done();
});

// Now any domain code can read it:
import { getTenantId } from './tenantContext.js';
await someService.doThing({ orgId: getTenantId() });
```

Arc doesn't bundle this — it's mongokit-specific. Arc's scope helpers (`getOrgId`, `getOrgContext`) remain the source of truth inside the request cycle; `createTenantContext()` is a complement for code that lives outside it.

## Plugin-order safety (mongokit ≥3.7)

Mongokit's `Repository` constructor accepts `pluginOrderChecks: 'warn' | 'throw' | 'off'` (default `'warn'`). Pass `'throw'` in production to catch foot-guns — e.g. installing `softDeletePlugin` AFTER `batchOperationsPlugin` silently bypasses soft-delete on `deleteMany`:

```ts
new Repository(Model, [
  multiTenantPlugin({...}),       // must precede cache + batch-ops
  softDeletePlugin(),             // must precede batch-ops
  batchOperationsPlugin(),
], {}, { pluginOrderChecks: 'throw' });
```

Arc doesn't surface this option — configure it directly on the mongokit `Repository` you hand to `defineResource({ adapter: createMongooseAdapter({ repository }) })`.

## Helpers reference

All exported from `@classytic/arc/scope`:

```ts
import {
  // Type guards
  isMember, isService, isElevated, isAuthenticated, hasOrgAccess,

  // Accessors (return undefined when not applicable — no throws)
  getUserId,       // authenticated | member | elevated
  getClientId,     // service only
  getOrgId,        // member | service | elevated
  getUserRoles,    // authenticated | member
  getOrgRoles,     // member only
  getServiceScopes, // service only (OAuth-style scope strings)
  getTeamId,       // member with teamId set

  // Canonical request extractor
  getOrgContext,

  // Constants
  PUBLIC_SCOPE, AUTHENTICATED_SCOPE,

  type RequestScope,
} from '@classytic/arc/scope';
```
