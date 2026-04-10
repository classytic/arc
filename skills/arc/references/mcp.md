# Arc MCP Integration

Expose Arc resources as MCP tools for AI agents. Two levels: zero-config auto-generation or fully custom tool definitions.

**Requires:** `@modelcontextprotocol/sdk` (peer dep), `zod` (peer dep)

```bash
npm install @modelcontextprotocol/sdk zod
```

## Level 1 — Auto-Generate from Resources

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';
import { createApp, loadResources } from '@classytic/arc/factory';

// Option A: Explicit resources
const app = await createApp({
  resources: [productResource, taskResource],
  auth: false,
  plugins: async (f) => {
    await f.register(mcpPlugin, { resources: [productResource, taskResource], auth: false });
  },
});

// Option B: Auto-discover from directory
const resources = await loadResources('./src/resources');
const app = await createApp({
  resources,
  plugins: async (f) => {
    await f.register(mcpPlugin, { resources, auth: false });
  },
});
```

Per-resource overrides:

```typescript
await app.register(mcpPlugin, {
  resources,
  auth: false,
  include: ['product', 'order'],          // only these get MCP tools
  overrides: { product: { operations: ['list', 'get'] } },
});
```

Per resource, generates up to 5 tools: `list_{plural}`, `get_{name}`, `create_{name}`, `update_{name}`, `delete_{name}`.

Resource `actions` (v2.8) also auto-generate MCP tools — each action becomes a tool named `{action}_{name}` with the action's input schema.

Tool handlers call `BaseController` — same pipeline as REST (auth, org-scoping, hooks, field permissions, cache).

### McpPluginOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `resources` | `ResourceDefinition[]` | required | Resources to expose |
| `auth` | `BetterAuthHandler \| McpAuthResolver \| false` | `false` | Auth mode (see Auth section) |
| `prefix` | `string` | `'/mcp'` | MCP endpoint path |
| `serverName` | `string` | `'arc-mcp'` | Server identity |
| `serverVersion` | `string` | `'1.0.0'` | Server version |
| `instructions` | `string` | — | LLM guidance on tool usage |
| `include` | `string[]` | — | Only these resources get tools (overrides `exclude`) |
| `exclude` | `string[]` | — | Resource names to exclude |
| `toolNamePrefix` | `string` | — | Global prefix: `'crm'` → `crm_list_products` |
| `overrides` | `Record<string, McpResourceConfig>` | — | Per-resource overrides (see below) |
| `authCacheTtlMs` | `number` | — | Cache auth results for N ms in stateless mode |
| `extraTools` | `ToolDefinition[]` | — | Hand-written tools alongside auto-generated |
| `extraPrompts` | `PromptDefinition[]` | — | Custom prompts |
| `stateful` | `boolean` | `false` | `false` = stateless (default, scalable). `true` = session-cached. |
| `sessionTtlMs` | `number` | `1800000` | Session TTL (stateful only) |
| `maxSessions` | `number` | `1000` | Max concurrent sessions (stateful only) |

### Tool Annotations (auto-set)

| Operation | Annotations |
|-----------|-------------|
| `list`, `get` | `readOnlyHint: true` |
| `create` | `destructiveHint: false` |
| `update`, `delete` | `destructiveHint: true, idempotentHint: true` |

### Per-Resource Overrides

```typescript
await app.register(mcpPlugin, {
  resources,
  include: ['job', 'project'],                // only expose these
  overrides: {
    job: {
      operations: ['list', 'get'],             // restrict ops
      toolNamePrefix: 'db',                    // db_list_jobs, db_get_job
      names: { get: 'get_job_by_id' },         // custom name for specific op
      hideFields: ['internalScore'],           // strip from schema
      descriptions: { list: 'Browse jobs' },   // custom descriptions
    },
  },
});
```

### Permission Filters (v2.4.2)

Resource permissions with `filters` are automatically enforced in MCP tools — same as REST:

```typescript
defineResource({
  name: 'task',
  permissions: {
    list: (ctx) => ({
      granted: !!ctx.user,
      filters: { orgId: ctx.user?.orgId, branchId: ctx.user?.branchId },
    }),
    create: (ctx) => !!ctx.user,                    // boolean works too
    delete: (ctx) => ({ granted: false, reason: 'Read-only' }),  // deny
  },
});

// MCP tools automatically:
// - list_tasks scopes by orgId + branchId from permission filters
// - create_task allowed if user is authenticated
// - delete_task returns "Permission denied: delete on task"
```

No extra config. `PermissionResult.filters` flow into `_policyFilters` → `BaseController.AccessControl`.

### Multiple MCP Endpoints

Mount separate servers scoped to different resource groups:

```typescript
await app.register(mcpPlugin, { resources: catalogResources, prefix: '/mcp/catalog' });
await app.register(mcpPlugin, { resources: orderResources, prefix: '/mcp/orders' });
```

## Auth — Three Modes

Arc doesn't enforce an auth strategy. You choose what fits.

### 1. No Auth (dev/testing/stdio)

```typescript
await app.register(mcpPlugin, { resources, auth: false });
```

All tools open. `ctx.user` is `null`, `scope.kind` is `"public"`. Permission guards like `!!ctx.user` correctly block — anonymous callers cannot bypass auth checks.

### 2. Better Auth OAuth 2.1 (production SaaS)

Full MCP spec-compliant OAuth 2.1: authorization code + PKCE, token exchange, dynamic client registration.

```typescript
// auth.config.ts — add mcp() plugin to Better Auth
import { mcp } from 'better-auth/plugins';
betterAuth({ plugins: [mcp({ loginPage: '/login' })] });

// app.ts
await app.register(mcpPlugin, { resources, auth: getAuth() });
```

Auto-registers discovery endpoints:
- `GET /.well-known/oauth-authorization-server` (RFC 8414)
- `GET /.well-known/oauth-protected-resource` (RFC 9728)

The auth flow:
```
MCP Client → discovers OAuth endpoints → registers → user authorizes → gets token
MCP Client → POST /mcp (Authorization: Bearer <token>)
Arc → auth.api.getMcpSession({ headers }) → { userId, organizationId }
Arc → BaseController scopes by org automatically
```

### 3. Custom Auth Function (API key, gateway, static org)

Pass an `McpAuthResolver` — a function that receives headers and returns identity:

```typescript
type McpAuthResolver = (headers: Record<string, string | undefined>) =>
  Promise<McpAuthResult | null> | McpAuthResult | null;
```

Return `McpAuthResult` to allow. Return `null` to reject (401).

**`McpAuthResult` fields:**
- `userId?` — human user ID (optional for machine principals)
- `organizationId?` — org scope
- `roles?` / `orgRoles?` — user roles
- `clientId?` — set this to produce `kind: "service"` scope (machine-to-machine)
- `scopes?` — OAuth scopes for service accounts

```typescript
// Human user — API key
auth: async (headers) => {
  if (headers['x-api-key'] !== process.env.MCP_API_KEY) return null;
  return { userId: 'alice', organizationId: 'org-123', roles: ['admin'] };
},

// Machine principal — service account (no userId needed)
auth: async (headers) => {
  const key = headers['x-service-key'];
  if (key !== process.env.SVC_KEY) return null;
  return { clientId: 'ingestion-pipeline', organizationId: 'org-123', scopes: ['write:events'] };
},

// Gateway-validated JWT (token already verified upstream)
auth: async (headers) => {
  const userId = headers['x-user-id'];
  const orgId = headers['x-org-id'];
  return userId ? { userId, organizationId: orgId } : null;
},

// Bearer token with custom validation
auth: async (headers) => {
  const token = headers['authorization']?.replace('Bearer ', '');
  if (!token) return null;
  const payload = await verifyJwt(token);
  return payload ? { userId: payload.sub, organizationId: payload.org } : null;
},
```

### Service Scope (machine-to-machine)

When `clientId` is present in the auth result, Arc produces `kind: "service"` RequestScope:

```
auth resolver returns { clientId: 'pipeline-v2', organizationId: 'org-a', scopes: ['read:all'] }
  → buildRequestContext sets _scope: { kind: 'service', clientId: 'pipeline-v2', organizationId: 'org-a', scopes: ['read:all'] }
  → ctx.user is null (machine principals don't masquerade as users)
  → isService(scope), getClientId(scope), getServiceScopes(scope) all work
```

When `userId` is present (without `clientId`), Arc produces `kind: "member"` or `kind: "authenticated"` as before.

### Multi-Tenancy

The `organizationId` from auth flows into BaseController's org-scoping automatically:

```
auth resolver returns { userId: 'alice', organizationId: 'org-a' }
  → buildRequestContext sets _scope: { kind: 'member', organizationId: 'org-a' }
  → QueryResolver adds { organizationId: 'org-a' } to every query
  → Agent only sees org-a's data — no cross-tenant leaks
```

Works with any `tenantField` (`organizationId`, `workspaceId`, `teamId`). Resources with `tenantField: false` are visible to all authenticated users.

## Level 2 — Custom Tools

```typescript
import { createMcpServer, defineTool, definePrompt } from '@classytic/arc/mcp';
import { z } from 'zod';

const server = await createMcpServer({
  name: 'social-automation',
  version: '1.0.0',
  instructions: 'Use list_providers first.',
  tools: [
    defineTool('send_notification', {
      description: 'Send a notification to a user or channel',
      input: {
        channel: z.enum(['email', 'telegram', 'whatsapp']),
        recipient: z.string(),
        message: z.string(),
      },
      annotations: { openWorldHint: true },
      handler: async ({ channel, recipient, message }) => {
        const result = await notificationService.send(channel, recipient, message);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    }),
  ],
  prompts: [
    definePrompt('content_calendar', {
      description: 'Plan a content calendar',
      args: { platforms: z.string(), theme: z.string().optional() },
      handler: ({ platforms, theme }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Plan content for ${platforms}` } }],
      }),
    }),
  ],
});
```

### defineTool() — Input is a flat Zod shape

Pass `{ field: z.string() }`, NOT `z.object(...)`. The SDK wraps it internally.

```typescript
defineTool('get_weather', {
  description: 'Get weather for a city',
  input: { city: z.string(), units: z.enum(['celsius', 'fahrenheit']).optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async ({ city, units }) => ({
    content: [{ type: 'text', text: JSON.stringify(await weatherApi.get(city, units)) }],
  }),
});
```

## Project Structure

Resources stay in `src/resources/`. Custom MCP tools co-locate with their resource:

```
src/resources/
  product/
    product.model.ts
    product.resource.ts
    product.mcp.ts          ← custom MCP tools (optional)
  order/
    order.model.ts
    order.resource.ts
    order.mcp.ts            ← domain-specific tools (fulfill, cancel, track)
```

Generate with CLI: `arc generate resource order --mcp` or `arc generate mcp analytics`

Wire in app.ts:

```typescript
import { fulfillOrderTool } from './resources/order/order.mcp.js';

await app.register(mcpPlugin, {
  resources,
  extraTools: [fulfillOrderTool],
});
```

## Guards — Permissions for Custom Tools

Auto-generated tools go through BaseController (permissions enforced automatically). Custom tools need explicit guards:

```typescript
import { defineTool, guard, requireAuth, requireOrg, requireRole, customGuard } from '@classytic/arc/mcp';
```

### guard() Wrapper — Compose Guards

```typescript
// Admin-only tool
defineTool('delete_all', {
  description: 'Delete all records',
  handler: guard(requireAuth, requireOrg, requireRole('admin'), async (input, ctx) => {
    // Only runs if: authenticated + has org + has admin role
    return { content: [{ type: 'text', text: 'Deleted' }] };
  }),
});
```

### Built-in Guards

| Guard | Rejects when |
|-------|-------------|
| `requireAuth` | No session or anonymous |
| `requireOrg` | No `organizationId` in session |
| `requireRole('admin')` | User lacks the role (checks `session.roles`) |
| `requireRole('admin', 'editor')` | User has neither role (OR logic) |
| `requireOrgId('org-x')` | Session org doesn't match |
| `customGuard(fn, msg)` | Predicate returns false |

### Inline Checks

For conditional logic inside handlers instead of wrapping:

```typescript
import { isAuthenticated, hasOrg, getUserId, getOrgId, denied } from '@classytic/arc/mcp';

defineTool('flexible_action', {
  description: 'Does different things based on auth',
  handler: async (input, ctx) => {
    if (!isAuthenticated(ctx)) return denied('Login required');

    const userId = getUserId(ctx);
    const orgId = getOrgId(ctx);

    // Different behavior for different orgs
    if (orgId === 'org-premium') {
      // premium features
    }

    return { content: [{ type: 'text', text: `Done by ${userId}` }] };
  },
});
```

### Custom Guard

```typescript
const businessHours = customGuard(
  () => { const h = new Date().getHours(); return h >= 9 && h < 17; },
  'Only available during business hours (9-5)',
);

const maxRequestsGuard = customGuard(
  async (ctx) => await rateLimiter.check(ctx.session?.userId),
  'Rate limit exceeded',
);

defineTool('sensitive_op', {
  description: 'Time-restricted operation',
  handler: guard(requireAuth, businessHours, async (input, ctx) => { ... }),
});
```

### Auth Resolver with Roles

For guards to check roles, your auth resolver must return them:

```typescript
auth: async (headers) => {
  const token = await verifyJwt(headers['authorization']);
  return {
    userId: token.sub,
    organizationId: token.org,
    roles: token.roles,         // ← requireRole() checks this
    orgRoles: token.orgRoles,   // ← for org-level permissions
  };
},
```

## fieldRulesToZod — Schema Conversion

Convert Arc's `schemaOptions.fieldRules` to flat Zod shapes for custom tools:

```typescript
import { fieldRulesToZod } from '@classytic/arc/mcp';

const createShape = fieldRulesToZod(resource.schemaOptions.fieldRules, {
  mode: 'create',               // 'create' | 'update' | 'list'
  hiddenFields: ['internalScore'],
  readonlyFields: ['slug'],
});
// → { name: z.string(), price: z.number(), category: z.enum([...]) }
```

## Schema Discovery — MCP Resources

Auto-registered for agent discovery:

- `arc://schemas` — list all resources with field counts, operations, presets
- `arc://schemas/{name}` — full schema for a specific resource

## Testing with Claude CLI

```bash
claude mcp add --transport http my-api http://localhost:3000/mcp
echo "List all products" | claude -p --allowedTools "mcp__my-api__*"
claude mcp remove my-api
```

## Transport Modes

### Stateless (default) — Production

Fresh server per request. No session tracking, no memory overhead. Best for horizontal scaling, serverless, edge.

```typescript
await app.register(mcpPlugin, { resources, auth: false });
// stateful defaults to false — stateless mode
```

- `POST /mcp` — each request gets a fresh server + transport
- `GET /mcp` — returns 405 (no SSE in stateless mode)
- `DELETE /mcp` — no-op

### Stateful — When Needed

Sessions cached with TTL. Use when you need server-initiated notifications or long-lived connections.

```typescript
await app.register(mcpPlugin, {
  resources,
  stateful: true,          // enable session persistence
  sessionTtlMs: 600000,   // 10 min TTL
  maxSessions: 500,        // max concurrent sessions
});
```

- `POST /mcp` — reuses session via `Mcp-Session-Id` header, or creates new
- `GET /mcp` — SSE stream for server-initiated messages
- `DELETE /mcp` — terminates session

Sessions: lazily created, TTL-cached, LRU-evicted at max capacity, auto-cleaned on shutdown.

## Health Endpoint

`GET /mcp/health` — no MCP protocol needed, plain JSON:

```json
{
  "status": "ok",
  "mode": "stateless",
  "tools": 11,
  "resources": 2,
  "toolNames": ["list_products", "get_product", ...],
  "sessions": null
}
```

Use to verify the MCP server is alive before configuring Claude CLI.

## DX Helpers (v2.4.4)

### ArcRequest — Typed Fastify Request

For `wrapHandler: false` routes, use `ArcRequest` instead of `(req as any).user`:

```typescript
import type { ArcRequest } from '@classytic/arc';

handler: async (req: ArcRequest, reply) => {
  req.user?.id;                    // typed
  req.scope.organizationId;        // typed (when member)
  req.signal;                      // AbortSignal (Fastify 5 built-in)
}
```

### envelope() — Response Helper

```typescript
import { envelope } from '@classytic/arc';

handler: async (req, reply) => {
  const data = await service.getResults();
  return reply.send(envelope(data));
  // → { success: true, data }
  return reply.send(envelope(data, { total: 100, page: 1 }));
  // → { success: true, data, total: 100, page: 1 }
}
```

### getOrgContext() — Canonical Org Extraction

Eliminates duplicated `req.user.organizationId || req.headers['x-organization-id']` patterns:

```typescript
import { getOrgContext } from '@classytic/arc/scope';

handler: async (req, reply) => {
  const { userId, organizationId, roles, orgRoles } = getOrgContext(req);
  // Works regardless of auth type (JWT, Better Auth, custom)
}
```

### createDomainError() — Error Factory

Eliminates manual `if (err.code) return status` mapping:

```typescript
import { createDomainError } from '@classytic/arc';

throw createDomainError('MEMBER_NOT_FOUND', 'Member does not exist', 404);
throw createDomainError('SELF_REFERRAL', 'Cannot refer yourself', 422);
throw createDomainError('INSUFFICIENT_BALANCE', 'Not enough credits', 402, { balance: 0 });
// Arc's error handler auto-maps statusCode to HTTP response
```

### onRegister — Resource Lifecycle Hook

Called during plugin registration with the scoped Fastify instance:

```typescript
defineResource({
  name: 'notification',
  onRegister: (fastify) => {
    setSseManager(fastify.sseManager);
  },
})
```

### preAuth — Pre-Auth Handlers for SSE/WebSocket

Run before auth middleware. Use for promoting `?token=` to `Authorization` header (EventSource can't set headers):

```typescript
additionalRoutes: [{
  method: 'GET',
  path: '/stream',
  wrapHandler: false,
  permissions: requireAuth(),
  preAuth: [(req) => {
    const token = req.query?.token;
    if (token) req.headers.authorization = `Bearer ${token}`;
  }],
  handler: sseHandler,
}]
```

### streamResponse — SSE Route Flag

Auto-sets SSE headers and bypasses Arc's response wrapper:

```typescript
additionalRoutes: [{
  method: 'POST',
  path: '/stream',
  streamResponse: true,        // SSE headers + no { success, data } wrapper
  permissions: requireAuth(),
  handler: async (request, reply) => {
    const { stream } = await generateStream({ abortSignal: request.signal });
    return reply.send(stream);
  },
}]
```

## Test Coverage

165 test files, 2439 tests. MCP-specific:

| Test File | Tests | Covers |
|-----------|-------|--------|
| `mcp-auth-e2e.test.ts` | 16 | All auth modes, multi-tenancy, permission filters, async permissions |
| `mcp-dx-features.test.ts` | 14 | include, names, prefix, disableDefaultRoutes, mcpHandler, guards, CRUD lifecycle |
| `resourceToTools.test.ts` | 12 | Tool generation, annotations, field hiding, soft delete |
| `createMcpServer.test.ts` | 10 | Server creation, tool registration, InMemoryTransport |
| `guards.test.ts` | 8 | requireAuth, requireOrg, requireRole, customGuard, composition |
| `dx-features.test.ts` | 17 | envelope, getOrgContext, createDomainError, onRegister, preAuth, streamResponse |
| Others | 32 | fieldRulesToZod, defineTool, definePrompt, buildRequestContext, sessionCache, authCache |
