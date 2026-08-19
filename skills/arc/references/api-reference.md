# Subpath Imports — Full Enumeration

Arc ships heavily tree-shaken: every feature has its own subpath. Pay only for what you import.

## Core

```typescript
import { defineResource, BaseController, BaseCrudController, allowPublic } from '@classytic/arc';
// createApp rateLimit gains `plan: { resolve, limits, default }` (2.22) — per-plan ceilings, `false` = unlimited, fail-safe fallback.
import { createApp, loadResources } from '@classytic/arc/factory';
import { defineModule, getModuleExports, orderModules } from '@classytic/arc/factory';
// Worker role (2.23) — same options object, headless process (no routes, no auth;
// events/jobs/schedules run). Primitive: `mountRoutes: false`; preset: 'worker'.
import { createWorker } from '@classytic/arc/factory';
import type { ArcWorker, CreateWorkerOptions } from '@classytic/arc/factory';

// Programmatic resource assembly (2.21) — for module authors composing
// base config + host seams without casts. Arrays concat, plain objects
// deep-merge, class instances last-win, `undefined` never clobbers.
import { mergeResourceConfig } from '@classytic/arc';
import type { ResourceSeams, SeamedResourceConfig, AdapterLike } from '@classytic/arc';
```

## Adapters (kit-owned, never arc)

```typescript
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { createDrizzleAdapter } from '@classytic/sqlitekit/adapter';
import { createPrismaAdapter } from '@classytic/prismakit/adapter';

import type {
  DataAdapter,
  RepositoryLike,
  AdapterRepositoryInput,
  AdapterFactory,
  OpenApiSchemas,
  SchemaMetadata,
  FieldMetadata,
  RelationMetadata,
} from '@classytic/repo-core/adapter';
import { asRepositoryLike, isRepository } from '@classytic/repo-core/adapter';
```

`MinimalRepo` / `StandardRepo` import directly from `@classytic/repo-core/repository`.

## Auth

```typescript
import { createBetterAuthAdapter, extractBetterAuthOpenApi } from '@classytic/arc/auth';

// Kit-owned BA overlays:
import { createBetterAuthOverlay, registerBetterAuthStubs } from '@classytic/mongokit/better-auth';
import { resolveBetterAuthCollections, BA_COLLECTIONS_BY_PLUGIN } from '@classytic/repo-core/better-auth';
```

## Permissions + scope

```typescript
import {
  allowPublic, requireAuth, requireRoles, requireOwnership,
  requireOrgMembership, requireOrgRole, requireTeamMembership,
  requireServiceScope, requireScopeContext, requireOrgInScope,
  // Platform-only role gate — an ORG role can never satisfy it. Required by
  // globally-scoped surfaces (jobsPlugin managementRoutes) that cannot filter by tenant.
  requirePlatformRole,

  // Agent-auth (2.13) — DPoP + capability mandates (AP2 / x402 / MCP)
  requireAgentScope, requireMandate, requireDPoP,
  type RequireAgentScopeOptions, type RequireMandateOptions,
  allOf, anyOf, when, denyAll,
  permissionMatrix,                                              // 2.21: { read, write, delete? } → full CRUD map
  createDynamicPermissionMatrix, createRoleHierarchy,
  fields, roles,
} from '@classytic/arc/permissions';

import {
  isMember, isService, isElevated, isAuthenticated, hasOrgAccess,
  getUserId, getUserRoles, getOrgId, getOrgRoles, getTeamId, getClientId,
  getServiceScopes, getScopeContext, getScopeContextMap,
  getAncestorOrgIds, isOrgInScope, getRequestScope,
  // Agent-auth scope accessors (2.13)
  getMandate, getDPoPJkt, type Mandate,
  requireUserId, requireClientId,                                // throw 401 (UnauthorizedError) if absent
  requireOrgId, requireTeamId,                                   // throw 403 (OrgRequiredError) if absent
  createTenantKeyGenerator,
} from '@classytic/arc/scope';
```

## Cache

```typescript
// HOST-LEVEL cache (action results, custom routes — NOT repo-bound paths)
import { MemoryCacheStore, RedisCacheStore, QueryCache } from '@classytic/arc/cache';

// REPO-BOUND cache (canonical) — getById/getAll/aggregate/count/etc
//   Install once on the kit's repo; arc forwards declarative `cache:`
//   config to req.cache automatically.
import { cachePlugin, type CacheOptions } from '@classytic/repo-core/cache';
//   Per-call shape (TanStack-shaped):
//     { staleTime, gcTime, swr, tags, bypass, enabled, key }
```

## Events

```typescript
import { eventPlugin, EventOutbox, MemoryOutboxStore } from '@classytic/arc/events';
import { RedisEventTransport } from '@classytic/arc/events/redis';
import { RedisStreamEventTransport } from '@classytic/arc/events/redis-stream';

// Event types live in primitives, NOT arc:
import type { EventMeta, DomainEvent, EventTransport, EventHandler } from '@classytic/primitives/events';
import { createEvent, createChildEvent, matchEventPattern } from '@classytic/primitives/events';
```

## Plugins

```typescript
import {
  healthPlugin, gracefulShutdownPlugin, ssePlugin,
  metricsPlugin, versioningPlugin,
  schedulesPlugin,   // 2.21: interval jobs, optional LockAdapter leader lease, no Redis
  type ScheduleDefinition,
} from '@classytic/arc/plugins';
// Lock contract (schedules.lock / MigrationRunner.lock) — one ecosystem standard:
// import type { LockAdapter } from '@classytic/repo-core/lock';
import { tracingPlugin } from '@classytic/arc/plugins/tracing';
import { auditPlugin } from '@classytic/arc/audit';
import { idempotencyPlugin } from '@classytic/arc/idempotency';
// Runtime capability registry (2.33) — declare process-local state so a
// `runtime: 'distributed'` boot fails on undeclared memory state:
import { declareRuntimeCapability } from '@classytic/arc/utils';
```

**Idempotency store — the one schema mistake that matters.** Backing the store
with a repository requires the key path to survive the filter. A Mongoose
schema with NO declared paths under a global `strictQuery: true` has EVERY
filter key stripped, so `getOne({ _id: key })` becomes `getOne({})`: one row
absorbs every key and responses replay across keys AND users. Declare the path
and pin the option on the schema:

```typescript
new Schema({ _id: String }, { strict: false, strictQuery: false, timestamps: false })
// NOT `new Schema({}, { _id: false, strict: false })`
```

The plugin's boot self-check (default on, `selfCheck: false` to disable) probes
for exactly this and refuses to register; the adapter also throws
`IdempotencyStoreMisconfiguredError` on any cross-key read at runtime.

## Integrations

```typescript
import { jobsPlugin } from '@classytic/arc/integrations/jobs';
import { websocketPlugin } from '@classytic/arc/integrations/websocket';
import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';
import { webhookPlugin } from '@classytic/arc/integrations/webhooks';
import { mcpPlugin, defineTool, definePrompt, fieldRulesToZod, resourceToTools } from '@classytic/arc/mcp';
```

## Enterprise auth (2.13)

```typescript
// SCIM 2.0 — IdP provisioning
import {
  scimPlugin,
  type ScimPluginOptions,
  type ScimResourceMapping,
  parseScimFilter, parseScimPatch,
  DEFAULT_USER_MAPPING, DEFAULT_GROUP_MAPPING,
  SCIM_USER_SCHEMA, SCIM_GROUP_SCHEMA,
  ScimError,
} from '@classytic/arc/scim';

// Better Auth → arc audit bridge
import {
  wireBetterAuthAudit,
  type AuthEvent, type AuthEventName,
  type WireBetterAuthAuditOptions,
} from '@classytic/arc/auth/audit';
```

## Hooks + presets

```typescript
import { createHookSystem, beforeCreate, afterCreate, beforeUpdate, afterUpdate } from '@classytic/arc/hooks';
import {
  bulkPreset, softDeletePreset, slugLookupPreset, treePreset,
  ownedByUserPreset, multiTenantPreset, auditedPreset, searchPreset,
  filesUploadPreset,
  type TenantFieldSpec,
} from '@classytic/arc/presets';
```

## Usage (2.22)

```typescript
// Per-actor, per-period (UTC YYYY-MM) usage counters — the accounting layer for
// quotas, plan enforcement, and usage-based billing. Decorates `fastify.usage`.
// requireQuota = the enforcement half: PermissionCheck gating on counters
// (429 quota.exceeded with { kind, used, limit, period, resetsAt }; limit may
// be a number, false = unlimited, or a plan-aware resolver; fail-open default).
import { usagePlugin, MemoryUsageStore, usagePeriod, requireQuota } from '@classytic/arc/usage';
import type { UsageStore, UsageBucket, UsagePluginOptions, UsageMeter, QuotaOptions } from '@classytic/arc/usage';
// Canonical store contract + cross-kit conformance: @classytic/repo-core/usage +
// runUsageStoreContract from @classytic/repo-core/testing; Mongo adapter:
// createMongoUsageStore from @classytic/mongokit/usage (>=3.22).
```

## Testing

```typescript
import {
  createTestApp, expectArc, createHttpTestHarness,
  TestAuthSession, TestAuthProvider, TestFixtures,
  runStorageContract,
  bootModuleApp,     // 2.22: real app around modules ("boots green ⇒ composes");
                     //   t.exports<T>(name) typed accessor; DB via `database` seam —
                     //   mongoMemoryDatabase default, any kit injectable
  mongoMemoryDatabase,
} from '@classytic/arc/testing';
```

## Utilities

```typescript
import {
  createStateMachine, CircuitBreaker, withCompensation, defineGuard,
  retry, queryParser,
  // AI SDK / OpenAI streams → Fastify reply (no JsonToSseTransformStream boilerplate)
  pipeUIMessageStreamToReply, UI_MESSAGE_STREAM_HEADERS, isReadableStream,
} from '@classytic/arc/utils';
import { defineMigration, MigrationRunner } from '@classytic/arc/migrations';
import { Type, ArcListResponse } from '@classytic/arc/schemas';
```

## Type-only barrel

```typescript
// Type-only — produces `export {}` at runtime; this is correct
import type { ArcRequest, IRequestContext, IControllerResponse } from '@classytic/arc/types';
```

## Notes

- **No default exports** outside Fastify plugin entry files (`fp()`-wrapped plugin entries — grep `export default fp` in src/ for the authoritative list).
- **Type-only subpaths** produce `export {}` at runtime — interfaces are erased.
- **Adapters live in kits**, not arc. Arc 2.12+ ships zero kit-bound adapters.
- **Event types live in `@classytic/primitives/events`**, not `@classytic/arc/events`. Arc re-exports the runtime `MemoryEventTransport` only.
