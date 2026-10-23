# Recipe: permissions, scope, tenancy

## Inline checks to declarative permissions

Before:

```ts
fastify.patch("/posts/:id", async (req) => {
  if (!req.user) throw fastify.httpErrors.unauthorized();
  const post = await Post.findById(req.params.id);
  const isAuthor = post.authorId.toString() === req.user.id;
  if (!isAuthor && !req.user.roles?.includes("admin")) throw fastify.httpErrors.forbidden();
});
```

After:

```ts
import { anyOf, defineResource, requireOwnership, requireRoles } from "@classytic/arc";

defineResource({
  name: "post",
  adapter,
  permissions: {
    update: anyOf(requireRoles(["admin"]), requireOwnership("authorId")),
    delete: requireRoles(["admin"]),
  },
});
```

`requireOwnership` grants with a data policy `{ authorId: userId }`, so the repository query is scoped to the caller's rows; admins pass without it. A permission returns `boolean` or a decision with `filters`/`scope`; combinators: `allOf`, `anyOf`, `not`, `when`, `denyAll`.

| Need | Check |
|---|---|
| any signed-in user | `requireAuth()` |
| org member | `requireOrgMembership()` |
| org role | `requireOrgRole("admin")` |
| team member | `requireTeamMembership()` |
| service token with scope | `requireServiceScope("jobs:bulk-write")` |
| scope context value | `requireScopeContext("branchId")` |
| target org inside caller's hierarchy | `requireOrgInScope(targetId)` |
| same gate on all CRUD keys | `permissionMatrix({ read, write, delete? })` |
| role by resource by action table | `createDynamicPermissionMatrix` |
| common shapes | `permissions.publicReadAdminWrite()`, `publicRead`, `adminOnly`, `readOnly` |

## Scope accessors instead of `req.user`

Before:

```ts
const userId = req.user._id;
const orgId = req.user.orgId;
```

After:

```ts
import { getUserId, getOrgId, requireOrgId, isAuthenticated } from "@classytic/arc/scope";

if (!isAuthenticated(req.scope)) return reply.code(401).send();
const orgId = requireOrgId(req.scope, "create-order");
const userId = getUserId(req.scope);
```

`RequestScope` kinds: `public`, `authenticated`, `member`, `service`, `elevated`. Read `organizationId` through `getOrgId`, never from the scope object. In a hook, `ctx.scope` carries `organizationId`, `userId`, `orgRoles`.

## Tenancy

| Case | Setting |
|---|---|
| normal tenant table | default `tenantField: "organizationId"` or `{ name: "multiTenant", tenantField }` |
| company-wide lookup table | `tenantField: false` |
| different scope key | `tenantField: "workspaceId"` |
| branch and project levels | `multiTenantPreset({ tenantFields: [{ field: "organizationId", type: "org" }, { field: "branchId", contextKey: "branchId" }] })` |

Scope tenancy at one layer. The `multiTenant` preset is the HTTP boundary; add the repository `tenant` option as defence in depth when jobs or CLIs share the repository. Populate `scope.context` and `ancestorOrgIds` in the auth function for multi-level tenancy; see the arc skill, references on multi-tenancy.

A preset tenant filter overwrites a body `organizationId` on update, which closes tenant-hopping. Never accept the tenant key from the client body or an `x-organization-id` header as a permission.

## Platform admin

`createApp({ elevation: { platformRoles: ["superadmin"], onElevation } })`: a superadmin sends `x-arc-scope: platform` to elevate; without the header they are a normal user. Handlers check `isElevated(scope)`.
