# Arc MCP Integration

Expose Arc resources as MCP tools for AI agents. Two levels: zero-config auto-generation or fully custom tool definitions.

**Requires:** `@modelcontextprotocol/sdk` (peer dep), `zod` (peer dep)

```bash
npm install @modelcontextprotocol/sdk zod
```

## Level 1 — Auto-Generate from Resources

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';

await app.register(mcpPlugin, {
  resources: [productResource, taskResource],
  auth: false,
  exclude: ['credential'],
  overrides: { product: { operations: ['list', 'get'] } },
});
```

Per resource, generates up to 5 tools: `list_{plural}`, `get_{name}`, `create_{name}`, `update_{name}`, `delete_{name}`.

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

All tools open. Every request gets `{ userId: 'anonymous' }`.

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

Return `{ userId, organizationId? }` to allow. Return `null` to reject (401).

```typescript
// API key
auth: async (headers) => {
  if (headers['x-api-key'] !== process.env.MCP_API_KEY) return null;
  return { userId: 'service', organizationId: 'org-123' };
},

// Gateway-validated JWT (token already verified upstream)
auth: async (headers) => {
  const userId = headers['x-user-id'];
  const orgId = headers['x-org-id'];
  return userId ? { userId, organizationId: orgId } : null;
},

// Static org (trusted internal network)
auth: async () => ({ userId: 'internal', organizationId: 'org-main' }),

// Bearer token with custom validation
auth: async (headers) => {
  const token = headers['authorization']?.replace('Bearer ', '');
  if (!token) return null;
  const payload = await verifyJwt(token);
  return payload ? { userId: payload.sub, organizationId: payload.org } : null;
},
```

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
