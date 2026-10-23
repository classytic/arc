# MCP: plugin setup and generated tools

Peer deps: `@modelcontextprotocol/server` (>=2), `zod`. Tests also use `@modelcontextprotocol/client`.

```typescript
import { mcpPlugin } from '@classytic/arc/mcp';
import { createApp, loadResources } from '@classytic/arc/factory';

const resources = await loadResources('./src/resources');
const app = await createApp({
  resources,
  plugins: async (f) => {
    await f.register(mcpPlugin, { resources, auth: false, expose: ['product', 'order'] });
  },
});
```

## Generated tools (per resource)

| Source | Tool name | Annotations |
|---|---|---|
| `list` | `list_{plural}` | `readOnlyHint` |
| `get` | `get_{name}` | `readOnlyHint` |
| `create` | `create_{name}` | `destructiveHint: false` |
| `update`, `delete` | `update_{name}`, `delete_{name}` | `destructiveHint`, `idempotentHint` |
| `actions` | `{action}_{name}` (input: `id` + action schema) | `destructiveHint` |
| custom routes (function or string handler) | `{operation or slug}_{name}` | GET: `readOnlyHint`, else `openWorldHint` |

- A CRUD op becomes a tool only when `permissions.<op>` is declared and the op is not in `disabledRoutes`.
- Tools run the same controller pipeline as REST: auth, tenant scope, permission policy, hooks, field masking, events.
- `list_*` accepts `page`, `limit`, `cursor` (keyset; `page` ignored when set), `sort`, `search`, `select`, `populate`, filters. `get_*` accepts `id`, `select`. `limit` max follows the resource `queryParser.maxLimit`.
- Mutating tools accept `_idempotencyKey` when an idempotency store is wired (register `idempotencyPlugin` before `mcpPlugin`). `idempotency.required` on a resource without a store throws at boot.
- Route/action tools: `mcp: false` hides, `mcp: { description, annotations }` customizes. `defineResource({ mcp: false })` removes the whole resource.

## McpPluginOptions

| Option | Default | Notes |
|---|---|---|
| `resources` | required | |
| `auth` | `false` | `false`, Better Auth instance, or `McpAuthResolver` (see mcp-auth.md) |
| `expose` | none | Default-deny allowlist of resource names. Preferred |
| `exclude` | none | Default-allow blocklist. Mutually exclusive with `expose` (throws) |
| `prefix` | `/mcp` | Endpoint path |
| `serverName`, `serverVersion` | `arc-mcp`, `1.0.0` | |
| `instructions` | none | LLM guidance |
| `toolNamePrefix` | none | `'crm'` gives `crm_list_products` |
| `overrides` | none | Per-resource `McpResourceConfig` |
| `extraTools`, `extraPrompts` | none | Hand-written tools/prompts |
| `stateful`, `sessionTtlMs`, `maxSessions` | `false`, 1800000, 1000 | Session mode |
| `authCacheTtlMs` | 5000 | Stateless auth-result cache; `0` disables |
| `dnsRebindingProtection` | on if `auth: false` | See below |

## Per-resource overrides

```typescript
await app.register(mcpPlugin, {
  resources,
  expose: ['job'],
  overrides: {
    job: {
      operations: ['list', 'get'],
      toolNamePrefix: 'db',                       // db_list_jobs
      names: { get: 'get_job_by_id' },
      hideFields: ['internalScore'],
      descriptions: {
        list: 'Browse jobs',
        get: ({ defaultDescription }) => `${defaultDescription} Prefer isActive: true.`,
      },
    },
  },
});
```

## Permissions

Resource `permissions` apply unchanged. A permission returning `allow({ policy })` scopes `list_*` by that policy; `deny('msg')` returns a tool error; boolean results work.

```typescript
import { allow, deny } from '@classytic/arc/permissions';
permissions: {
  list: (ctx) => ctx.user ? allow({ policy: { orgId: ctx.user.orgId } }) : deny('Auth required'),
  delete: () => deny('Read-only'),
}
```

## DNS rebinding protection

Validates `Host`/`Origin`. Default on when `auth: false` (localhost set), off when auth is configured.

```typescript
mcpPlugin({ resources, auth, dnsRebindingProtection: {} });                          // localhost + auth
mcpPlugin({ resources, dnsRebindingProtection: { allowedHosts: ['mcp.example.com'] } });
mcpPlugin({ resources, auth: false, dnsRebindingProtection: false });                // public
```

Absent `Origin` passes; present-but-unlisted is refused. `${prefix}/health` is exempt.

## Endpoints and modes

| Mode | Behavior |
|---|---|
| Stateless (default) | `POST /mcp` fresh server per request; `GET` returns 405; `DELETE` no-op. Use for scaling/serverless |
| `stateful: true` | `POST` reuses `Mcp-Session-Id`; `GET` is SSE; `DELETE` ends session. TTL cache, LRU eviction at `maxSessions` |

- `GET /mcp/health` returns `{ status, mode }`; with valid auth (or `auth: false`) it also returns `tools`, `resources`, `toolNames`, `sessions`.
- Resources `arc://schemas` and `arc://schemas/{name}` expose resource schemas to agents.
- Multiple endpoints: register `mcpPlugin` repeatedly with different `resources` and `prefix`.

## Tool-name collisions

`createMcpServer` resolves duplicates before the SDK sees them. A preset tool vs a user tool: the preset is renamed (`softdelete_restore_post`). Any other duplicate throws `ArcError` code `arc.mcp.tool_name_collision` naming both `source` labels. `resolveToolCollisions(tools)` is exported for tests.

## Scaffold

`arc generate resource order --mcp` or `arc generate mcp analytics` creates `<name>.mcp.ts`; pass its tools via `extraTools`.
