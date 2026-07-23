# Removed APIs

**Summary**: APIs removed by version, with migration targets. Do not re-add without a strong reason.
**Sources**: CHANGELOG.md, commit history.
**Last updated**: 2026-07-22.

---

## v2.24

| Removed | Replacement | Why |
|---|---|---|
| Outbox contract exports from `@classytic/arc/events` — `OutboxStore`, `OutboxWriteOptions`, `OutboxClaimOptions`, `OutboxAcknowledgeOptions`, `OutboxFailOptions`, `OutboxErrorInfo`, `OutboxFailureContext`, `OutboxFailureDecision`, `OutboxFailurePolicy`, `OutboxOwnershipError`, `InvalidOutboxEventError` | Import from `@classytic/primitives/outbox` (>=0.13) | Contract was duplicated in both packages with conflicting source-of-truth docs; the duplicate class identities broke cross-package `instanceof`. Primitives owns contracts, arc owns runtime (`EventOutbox`, `MemoryOutboxStore`, `repositoryAsOutboxStore`, `exponentialBackoff` — all still in arc). |
| `validateResourceConfig` / `assertValidConfig` / `formatValidationErrors` re-export from `@classytic/arc/utils` | Import from `@classytic/arc/core` | Utils must not import upward into the resource kernel (boundary rule). |

## v2.16

| Removed | Replacement | Why |
|---|---|---|
| `@classytic/arc/org` subpath (entire module) — `organizationPlugin`, `orgGuard`, `requireOrg`, preHandler `requireOrgRole`, `OrgAdapter`, `OrgDoc`, `MemberDoc`, `InvitationDoc`, `InvitationAdapter`, `OrgRole`, `OrgPermissionStatement`, `OrganizationPluginOptions`, `orgMembershipCheck`, `getUserOrgRoles`, `hasOrgRole` | Better Auth `organization()` plugin (arc reads BA tables via standard `defineResource`); for permission checks, `requireOrgRole` from `@classytic/arc/permissions` (a `PermissionCheck`, NOT a preHandler) | Zero verified consumers across classytic workspaces. Flat `Organization 1—* Member` model with one role per pair didn't fit real multi-tenant deployments (hosts reached for BA's plugin or custom resources). Also resolved a name collision with the canonical `requireOrgRole` in `@classytic/arc/permissions`. |
| Root re-export of `getUserId` from `@classytic/arc` | Import from the subpath that matches the input shape — `getUserId(user)` from `@classytic/arc/utils` (raw user object), `getUserId(scope)` from `@classytic/arc/scope` (canonical scope accessor) | Two functions with different signatures behind one root-barrel name were a DX footgun. |

## v2.10

| Removed | Replacement | Why |
|---|---|---|
| `@classytic/arc/policies` | `@classytic/arc/permissions` | Policy engine duplicated [[permissions]] (RBAC, ownership, tenant filters via `requireOrgInScope`) |
| `@classytic/arc/rpc` | External HTTP client of choice | Orphaned; no internal users |
| `@classytic/arc/dynamic` (`ArcDynamicLoader`) | `factory/loadResources` | Two filesystem loaders was one too many. See [[factory]] |

## v2.9

| Removed | Replacement |
|---|---|
| `createActionRouter`, `buildActionBodySchema` | `defineResource({ actions: { ... } })` |
| `ResourceConfig.onRegister` | `actions` or resource `hooks` |
| `PluginResourceResult.additionalRoutes` | Return `routes: RouteDefinition[]` from plugins |

## v2.5.2

| Removed | Replacement |
|---|---|
| `toPlugin()` on factory | `createApp({ resources })` directly. See [[factory]] |

## Related
- See [`/changelog/v2.md`](../changelog/v2.md) for the full release history with replacement context.
