# MCP: custom tools, guards, AI SDK bridge

```typescript
import { z } from 'zod';
import { createMcpServer, defineTool, definePrompt } from '@classytic/arc/mcp';
```

## defineTool and definePrompt

`input` is a flat Zod shape (`{ field: z.string() }`), not `z.object(...)`. The SDK wraps it in a stripping object.

```typescript
export const notifyTool = defineTool('send_notification', {
  description: 'Send a notification',
  input: { channel: z.enum(['email', 'telegram']), recipient: z.string(), message: z.string() },
  annotations: { openWorldHint: true },
  handler: async ({ channel, recipient, message }, ctx) => {
    const result = await notifications.send(channel, recipient, message);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});

export const planPrompt = definePrompt('content_calendar', {
  description: 'Plan a content calendar',
  args: { platforms: z.string(), theme: z.string().optional() },
  handler: ({ platforms }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Plan content for ${platforms}` } }],
  }),
});

// With the plugin
await app.register(mcpPlugin, { resources, extraTools: [notifyTool], extraPrompts: [planPrompt] });

// Standalone server
const server = await createMcpServer({ name: 'tools', version: '1.0.0', tools: [notifyTool], prompts: [planPrompt] });
```

- `ToolContext`: `{ session, log(level, msg), extra }`. `session` is the `McpAuthResult` or `null` (no auth). `log` writes server-side (`fastify.log`, or `createMcpServer({ logger })`), never to the client.
- Handler returns `CallToolResult`: `{ content: [{ type: 'text', text }], isError? }`. `toCallToolResult`, `toCallToolSuccess`, `toCallToolError`, `permissionDeniedResult` build it.
- `defineTool<MySession>(...)` widens `ctx.session` to a host type extending `McpAuthResult`.
- Custom tools bypass resource permissions: guard them explicitly.

## Guards

```typescript
import { guard, requireAuth, requireOrg, requireRole, requireOrgId, customGuard } from '@classytic/arc/mcp';

defineTool('purge', {
  description: 'Purge records',
  handler: guard(requireAuth, requireOrg, requireRole('admin', 'editor'), async (input, ctx) => {
    return { content: [{ type: 'text', text: 'done' }] };
  }),
});

const businessHours = customGuard(() => new Date().getHours() >= 9, 'Business hours only');
```

| Guard | Rejects when |
|---|---|
| `requireAuth` | no session or anonymous |
| `requireOrg` | no `organizationId` |
| `requireRole(...roles)` | none of the roles in `session.roles` (OR) |
| `requireOrgId(id)` | session org differs |
| `customGuard(fn, msg)` | predicate false |

Inline: `isAuthenticated(ctx)`, `hasOrg(ctx)`, `isOrg(ctx, id)`, `getUserId(ctx)`, `getOrgId(ctx)`, `denied(msg)` (returns an `isError` result). `requireRole` needs the auth resolver to return `roles`.

## fieldRulesToZod

Build flat shapes from `schemaOptions.fieldRules`:

```typescript
import { fieldRulesToZod } from '@classytic/arc/mcp';

const shape = fieldRulesToZod(resource.schemaOptions.fieldRules, {
  mode: 'create',                // 'create' | 'update' | 'list'
  hiddenFields: ['internalScore'],
  readonlyFields: ['slug'],
});
```

## Compose controller calls

`invokeController(controller, op, input, options)` runs a controller method with the full pipeline (permissions, hooks, events) outside HTTP; `mcpHandlerAdapter(fn)` wraps a handler so thrown `ArcError`s become canonical error results.

```typescript
import { defineTool, mcpHandlerAdapter, invokeController } from '@classytic/arc/mcp';

defineTool('archive_post', {
  description: 'Archive a post',
  input: { id: z.string() },
  handler: mcpHandlerAdapter(async (input, ctx) =>
    invokeController(postController, 'update', { id: input.id, archived: true },
      { session: ctx.session, resourceName: 'post' })),
});
```

## AI SDK bridge

Expose one AI SDK `tool()` builder over MCP. The bridge rejects unauthenticated callers, runs the optional `guard`, maps `{ error }` results and thrown errors to `isError`, and calls `buildTool(ctx)` per request.

```typescript
import { bridgeToMcp, buildMcpToolsFromBridges, getUserId, hasOrg, type McpBridge } from '@classytic/arc/mcp';
import { tool } from 'ai';

export const triggerJob: McpBridge = {
  name: 'trigger_job',
  description: 'Start a job.',
  inputSchema: { phase: z.enum(['investigate', 'fix']) },
  annotations: { destructiveHint: true },
  buildTool: (ctx) => tool({
    description: 'Start a job.',
    inputSchema: z.object({ phase: z.enum(['investigate', 'fix']) }),
    execute: async ({ phase }) => ({ jobId: `${getUserId(ctx)}-${phase}` }),
  }),
  guard: (ctx) => (hasOrg(ctx) ? null : 'Organization scope required'),
};

await app.register(mcpPlugin, {
  resources,
  extraTools: buildMcpToolsFromBridges([triggerJob], { exclude: readOnly ? ['trigger_job'] : [] }),
});
```

`buildMcpToolsFromBridges` also takes `{ include: [...] }`. `bridgeToMcp(bridge)` converts one.
