# MCP: testing

`@classytic/arc/mcp/testing` serves the real Streamable HTTP transport on an ephemeral loopback port (needs `@modelcontextprotocol/client`). Always `await client.close()`.

## createTestMcpClient

Builds tools from resources and connects a client; no Fastify app needed.

```typescript
import { createTestMcpClient } from '@classytic/arc/mcp/testing';

const client = await createTestMcpClient({
  pluginOptions: { resources: [productResource], extraTools: [notifyTool] },
  auth: { userId: 'u1', organizationId: 'org-1', roles: ['admin'] },
});

const tools = await client.listTools();
expect(tools.map((t) => t.name)).toContain('list_products');

const res = await client.callTool('list_products', { limit: 5 });
expect(res.isError).toBeFalsy();
await client.close();
```

| Option | Notes |
|---|---|
| `pluginOptions` | `resources`, `overrides`, `expose`, `exclude`, `toolNamePrefix`, `extraTools`, `extraPrompts`, `instructions` |
| `auth` | `McpAuthResult` for the session; `null` or omitted runs anonymous |
| `serverName` | default `test-mcp` |

`callTool` returns `{ content: [{ type, text }], isError? }`; parse `content[0].text` as JSON.

## connectMcpTestClient

For a server you built with `createMcpServer`:

```typescript
import { connectMcpTestClient } from '@classytic/arc/mcp/testing';

const server = await createMcpServer({ name: 't', tools: [notifyTool] });
const { client, close } = await connectMcpTestClient(server);
const result = await client.callTool({ name: 'send_notification', arguments: { /* ... */ } });
await close();
```

`client` is the SDK `Client` (`listTools`, `callTool`, `listPrompts`).

## What to assert

- Tool list per `expose`/`exclude`/`operations` and the generated names.
- Anonymous session is denied where permissions require a user.
- Tenant isolation: two orgs, each sees only its rows.
- Custom tools reject without a role (`isError: true`).

## Manual check with Claude CLI

```bash
claude mcp add --transport http my-api http://localhost:3000/mcp
echo "List all products" | claude -p --allowedTools "mcp__my-api__*"
claude mcp remove my-api
```

Check `GET /mcp/health` first to confirm the server is up.
