# Smells: auth, scope, tenancy

## A1. Permission checks inside handlers [critical]

Grep: `(req|request)\.user\.(role|roles)\b`, `roles\.includes\(`, `if\s*\(\s*!\s*req\.user\s*\)`, `throw new Error\(['"](Unauthorized|Forbidden)`.
Why: error shapes diverge, `id` versus `_id` mismatches silently bypass ownership, and no row-level filter reaches the query.
Fix: declare checks in `permissions`; an ownership grant carries a data policy that scopes the query.

```ts
permissions: {
  list: allowPublic(),
  create: requireRoles(["admin", "editor"]),
  update: anyOf(requireRoles(["admin"]), requireOwnership("createdBy")),
  delete: requireRoles(["admin"]),
}
```

Human plus service callers: `anyOf(requireOrgRole("admin"), requireServiceScope("jobs:bulk-write"))`. Import from `@classytic/arc/permissions`.

## A2. Reading `req.user` fields for identity [critical]

Grep: `req(uest)?\.user\.(_id|id|orgId|organizationId|tenantId|teamId|parentOrgId)`.
Why: `request.user` is undefined on public routes (crash only when an anonymous caller arrives), service tokens carry no user, org hierarchy is ignored.
Fix: scope accessors from `@classytic/arc/scope`: `getUserId`, `getOrgId`, `getOrgRoles`, `getServiceScopes`, `getScopeContext`, `getAncestorOrgIds`, `isAuthenticated`, `isMember`, `isService`, `isElevated`, `hasOrgAccess`, `isOrgInScope`. Prefer permission combinators (`requireOrgRole`, `requireScopeContext`, `requireOrgInScope`) over accessor logic in handlers. Never `x-user-id` or `x-role` headers as identity.

## A3. Hand-rolled "missing org" guard [medium]

Grep: `if\s*\(\s*!\s*getOrgId\(`, same with `getUserId`, `getClientId`, `getTeamId`.
Fix: `requireOrgId(scope, hint?)`, `requireUserId(scope, hint?)`, `requireClientId`, `requireTeamId`. They return the value or throw an ArcError with the right status.

```ts
const orgId = requireOrgId(req.scope);
const userId = requireUserId(req.scope, "finalize-checkout");
```

## A4. Default `tenantField` on company-wide tables [high]

Grep: resources for lookup, currency, platform settings without `tenantField`.
Why: the default `organizationId` silently scopes reads to the caller's org; a shared table returns empty forever.
Fix: `defineResource({ name: "currency", tenantField: false })`; a different scope key is `tenantField: "workspaceId"`.

## A5. Wrong tenant config key [critical]

Grep: `tenant:\s*\{\s*field\s*:`, any tenant object whose keys are not `strategy`, `enabled`, `tenantField`, `fieldType`, `ref`.
Why: unknown keys are ignored, the default field applies, and a host with a custom field reads and writes unscoped.
Fix: use `tenantField` (top-level resource option, `multiTenant` preset, or a repo-core `TenantConfig`). Type seam objects as `TenantConfig` from `@classytic/repo-core/tenant` so a wrong key fails the build.

## A6. Custom controller drops resource options [high]

Grep: `extends (BaseController|BaseCrudController)` whose constructor does not forward `tenantField`, `idField`, `schemaOptions`, `cache`, `onFieldWriteDenied`.
Why: arc cannot thread options into a controller you built.
Fix: forward through `super(repo, opts)` and mirror on `defineResource`, or delete the controller; the auto-built one covers most cases. Compose `SoftDeleteMixin`, `BulkMixin`, `TreeMixin`, `SlugMixin` rather than rewriting methods. Domain commands that must keep the pipeline belong in `writes` or `actions`.

## A7. Silent strip of denied field writes [medium]

Grep: sensitive fields (`role`, `permissions`, `organizationId`) on a resource with `onFieldWriteDenied: "strip"`.
Why: the default is `"reject"` (403 with the denied list); `"strip"` hides privilege-escalation attempts.
Fix: keep `reject` for sensitive resources; tests assert 403 on protected-field writes.

## A8. Webhook signature over parsed body [critical]

Grep: `verifySignature\(.*req\.body`, `JSON\.stringify\(req\.body\)` near a hash or HMAC.
Why: the signature covers the exact bytes sent. A parsed or re-serialized body does not match them; `verifySignature` throws `TypeError` for a non-string, non-Buffer body.
Fix: route `config: { rawBody: true }` and `verifySignature(req.rawBody, secret, signature)` from `@classytic/arc/integrations/webhooks`.

## A9. SSE token in query string without `preAuth` [critical]

Grep: EventSource routes reading `req.query.token` and verifying inline.
Fix: route `preAuth: [(req) => { req.headers.authorization = \`Bearer ${(req.query as { token: string }).token}\`; }]` so normal auth and `permissions` still run.

## A10. Headers set in async `onSend` [critical]

Grep: `addHook\(['"]onSend`; check whether the body calls `reply.header(`.
Why: races Fastify's flush and surfaces as intermittent `ERR_HTTP_HEADERS_SENT` under slow responses.
Fix: set headers in `onRequest` or `preSerialization`.

## A11. Hand-wired authentication [low]

Grep: `@fastify/jwt` registered by hand, custom `app.authenticate` decorator.
Fix: `createApp({ auth: { type: "jwt", jwt: { secret } } })`, or `{ type: "betterAuth", betterAuth: createBetterAuthAdapter({ auth }) }` from `@classytic/arc/auth`. Arc decorates `authenticate`, `optionalAuthenticate`, `authorize` and wires permission checks.
