# Subpath Imports — Full Enumeration

Arc ships heavily tree-shaken: every feature has its own subpath. Pay only for what you import.

## Core

```typescript
import { defineResource, BaseController, BaseCrudController, allowPublic } from '@classytic/arc';
import { createApp, loadResources } from '@classytic/arc/factory';
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
  // Agent-auth (2.13) — DPoP + capability mandates (AP2 / x402 / MCP)
  requireAgentScope, requireMandate, requireDPoP,
  type RequireAgentScopeOptions, type RequireMandateOptions,
  allOf, anyOf, when, denyAll,
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
} from '@classytic/arc/plugins';
import { tracingPlugin } from '@classytic/arc/plugins/tracing';
import { auditPlugin } from '@classytic/arc/audit';
import { idempotencyPlugin } from '@classytic/arc/idempotency';
```

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

## Testing

```typescript
import {
  createTestApp, expectArc, createHttpTestHarness,
  TestAuthSession, TestAuthProvider, TestFixtures,
  runStorageContract,
} from '@classytic/arc/testing';
```

## Utilities

```typescript
import {
  createStateMachine, CircuitBreaker, withCompensation, defineGuard,
  retry, queryParser,
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

- **No default exports** outside Fastify plugin entry files (`auditPlugin`, `authPlugin`, `eventPlugin`, `idempotencyPlugin`, `introspectionPlugin`).
- **Type-only subpaths** produce `export {}` at runtime — interfaces are erased.
- **Adapters live in kits**, not arc. Arc 2.12+ ships zero kit-bound adapters.
- **Event types live in `@classytic/primitives/events`**, not `@classytic/arc/events`. Arc re-exports the runtime `MemoryEventTransport` only.
