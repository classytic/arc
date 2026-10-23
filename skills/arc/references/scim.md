# SCIM 2.0 provisioning

`@classytic/arc/scim` mounts `/scim/v2/Users` and `/scim/v2/Groups` over the repository contract (`@classytic/repo-core/adapter`). It is a thin REST layer over `resource.adapter.repository`, NOT arc's HTTP controller pipeline.

```typescript
import { scimPlugin } from '@classytic/arc/scim';

await app.register(scimPlugin, {
  users: { resource: userResource },        // existing arc resource
  groups: { resource: orgResource },        // optional
  bearer: process.env.SCIM_TOKEN,           // XOR verify
});
```

Mounted: `GET/POST/PUT/PATCH/DELETE /scim/v2/Users[/:id]`, same for `Groups`, plus `ServiceProviderConfig`, `ResourceTypes`, `Schemas`.

## Options

| Option | Purpose |
|---|---|
| `users`, `groups` | `{ resource, mapping? }`; `groups` optional |
| `bearer` | Static token. Exactly one of `bearer` / `verify`; the plugin throws at boot otherwise |
| `verify(request)` | `true` accepts, `false` or throw rejects (short-lived JWTs, multi-IdP) |
| `prefix` | Default `/scim/v2` |
| `maxResults` | Max page size for `count` (default 200) |
| `observe(event)` | Per-request `ScimObservedEvent { resourceType, op, status, durationMs, scimType?, path }`; default logs `request.log.info({ scim }, 'scim.request')` |

```typescript
verify: async (request) => {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const claims = await verifyJwt(auth.slice(7));
  return claims.scope?.includes('scim:write') ?? false;
},
```

## What fires for SCIM

Only what is composed at the kit/repository layer (audit-trail, multi-tenant, field-filter plugins; `repo.on('before:create', fn)`). Resource-level `hooks`, `permissions` and `audit: true` do NOT fire. Gate at the edge with `bearer` / `verify`.

## Method mapping

| SCIM | Repository call |
|---|---|
| `GET /Users` | `getAll({ filters, page, limit, sort })` (filter parser output) |
| `GET /Users/:id` | `getById(id)` |
| `POST /Users` | `create(data)` through `mapping.attributes` |
| `PUT /Users/:id` | `bulkWrite([{ replaceOne }])`; repository without `bulkWrite` => HTTP 501 (no partial-merge fallback) |
| `PATCH /Users/:id` | `findOneAndUpdate({ id }, ops)` with `$set`, `$unset`, `$push`, `$pull` |
| `DELETE /Users/:id` | `delete(id)` |

Kit support:

| Kit | `$set` / `$unset` | `$push` / `$pull` | PUT |
|---|---|---|---|
| mongokit | yes | yes | yes |
| sqlitekit | yes | refused => 400 `scimType: invalidValue` | yes (omitted columns set NULL) |
| minimal repo (no `findOneAndUpdate`) | `$set` via `update` | 400 | 501 |

If an IdP needs PUT and the kit lacks `bulkWrite`, switch the IdP to PATCH-only mode (Okta and Azure AD support it).

## Mapping

Default user mapping (Better Auth shaped): `id`=>`id`, `userName`=>`email`, `name.formatted` and `displayName`=>`name`, `emails.value`=>`email`, `active`=>`isActive`, `externalId`=>`externalId`, `meta.created`=>`createdAt`, `meta.lastModified`=>`updatedAt`. Groups: `id`, `displayName`=>`name`, `externalId`, `meta.*`.

```typescript
import { scimPlugin, DEFAULT_USER_MAPPING } from '@classytic/arc/scim';

users: {
  resource: userResource,
  mapping: { attributes: { ...DEFAULT_USER_MAPPING.attributes, userName: 'username', 'name.familyName': 'lastName' } },
},
```

## Filters (RFC 7644)

Operators: `eq ne co sw ew gt ge lt le pr`, `and or not`, parentheses.

```
filter=userName eq "alice@acme.com" and active eq true
filter=meta.lastModified gt "2025-01-01T00:00:00Z"
```

Pagination: `startIndex` (1-based) and `count` (capped by `maxResults`).

## Wire format

- Content-Type `application/scim+json` (parser auto-registered).
- Errors: `{ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '400', scimType: 'invalidFilter', detail }`.
- Discovery advertises `patch` and `filter` supported, `bulk`, `changePassword`, `etag` not supported. `/Schemas` returns id and name only.

Not supported: `/Bulk`, first-class EnterpriseUser extension (pass attributes through `mapping.attributes`).

## Checklist

- Serve on the same host as the REST surface.
- Rotate `SCIM_TOKEN`; prefer `verify` with short-lived JWTs for several IdPs.
- Register the audit plugin on the repository (mongokit: `repo.use(auditTrailPlugin())`), not `defineResource({ audit })`.
- Confirm the kit exposes `findOneAndUpdate` (PATCH) and `bulkWrite` (PUT).
- Test the IdP connector against `playground/enterprise-auth/`.
