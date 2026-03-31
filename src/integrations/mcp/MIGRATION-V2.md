# MCP SDK v2 Migration Guide

> **Status:** v2 is pre-alpha as of March 2026. v1.x remains production-recommended.
> Apply this guide when `@modelcontextprotocol/server` ships stable v2.

## Package Changes

```bash
# Remove v1
npm uninstall @modelcontextprotocol/sdk

# Install v2 (three packages replace one)
npm install @modelcontextprotocol/server @modelcontextprotocol/node
# Only if tests use InMemoryTransport:
npm install -D @modelcontextprotocol/core
```

Update `package.json` peer deps:

```diff
- "@modelcontextprotocol/sdk": ">=1.28.0"
+ "@modelcontextprotocol/server": ">=2.0.0"
+ "@modelcontextprotocol/node": ">=2.0.0"
```

Update `peerDependenciesMeta`:

```diff
- "@modelcontextprotocol/sdk": { "optional": true }
+ "@modelcontextprotocol/server": { "optional": true },
+ "@modelcontextprotocol/node": { "optional": true }
```

## File: `src/integrations/mcp/createMcpServer.ts`

### Import

```diff
- const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
+ const { McpServer } = await import("@modelcontextprotocol/server");
```

### Schema wrapping — v2 requires `z.object()`, raw shapes no longer accepted

```diff
  const config: Record<string, unknown> = {};
  if (tool.title) config.title = tool.title;
  if (tool.description) config.description = tool.description;
- if (tool.inputSchema) config.inputSchema = tool.inputSchema;
- if (tool.outputSchema) config.outputSchema = tool.outputSchema;
+ if (tool.inputSchema) {
+   const { z } = await import("zod");
+   config.inputSchema = z.object(tool.inputSchema);
+ }
+ if (tool.outputSchema) {
+   const { z } = await import("zod");
+   config.outputSchema = z.object(tool.outputSchema);
+ }
```

> **Why this works in v2:** v2 uses Standard Schema (Zod v4 native). No more
> internal `zod/v4-mini` wrapping — `z.object()` from our Zod passes through directly.
> The "mixed Zod versions" error that plagued v1 does not exist in v2.

### Handler context — `extra` becomes `ctx` with structured accessors

```diff
  srv.registerTool(
    tool.name,
    config,
-   (input: Record<string, unknown>, extra: Record<string, unknown>) => {
+   (input: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const toolCtx: ToolContext = {
        session: authRef?.current ?? null,
        log: async (level, message) => {
          try {
-           const notify = extra?.sendNotification as ((...a: unknown[]) => Promise<void>) | undefined;
-           if (notify) await notify({ method: "notifications/message", params: { level, data: message } });
+           const mcpReq = ctx?.mcpReq as { notify?: (...a: unknown[]) => Promise<void> };
+           if (mcpReq?.notify) await mcpReq.notify({ method: "notifications/message", params: { level, data: message } });
          } catch { /* best-effort */ }
        },
-       extra,
+       extra: ctx,
      };
      return tool.handler(input, toolCtx);
    },
  );
```

## File: `src/integrations/mcp/mcpPlugin.ts`

### Import

```diff
- const mod = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
- StreamableHTTPServerTransport = mod.StreamableHTTPServerTransport as typeof StreamableHTTPServerTransport;
+ const mod = await import("@modelcontextprotocol/node");
+ StreamableHTTPServerTransport = mod.NodeStreamableHTTPServerTransport as typeof StreamableHTTPServerTransport;
```

### Error message update

```diff
  throw new Error(
-   "@modelcontextprotocol/sdk and zod are required for MCP support. " +
-   "Install them: npm install @modelcontextprotocol/sdk zod",
+   "@modelcontextprotocol/server, @modelcontextprotocol/node, and zod are required for MCP support. " +
+   "Install them: npm install @modelcontextprotocol/server @modelcontextprotocol/node zod",
  );
```

## File: `src/optional-peers.d.ts`

```diff
- declare module "@modelcontextprotocol/sdk/server/mcp.js" {
+ declare module "@modelcontextprotocol/server" {
    export class McpServer {
      constructor(info: { name: string; version: string }, options?: Record<string, unknown>);
+     registerTool(...args: unknown[]): unknown;
+     registerPrompt(...args: unknown[]): void;
      tool(...args: unknown[]): void;
      prompt(...args: unknown[]): void;
      resource(...args: unknown[]): void;
      connect(transport: unknown): Promise<void>;
    }
+ }

- declare module "@modelcontextprotocol/sdk/server/streamableHttp.js" {
-   export class StreamableHTTPServerTransport {
+ declare module "@modelcontextprotocol/node" {
+   export class NodeStreamableHTTPServerTransport {
      sessionId: string;
      constructor(options?: Record<string, unknown>);
      handleRequest(req: unknown, res: unknown, body?: unknown): Promise<void>;
      close(): void;
    }
  }
```

## File: `tsdown.config.ts`

```diff
  // MCP
  "@modelcontextprotocol/sdk",
  /^@modelcontextprotocol\//,
```

No change needed — the regex already catches all `@modelcontextprotocol/*` packages.

## File: `tests/integrations/mcp/createMcpServer.test.ts`

### InMemoryTransport moved to core (internal)

```diff
- const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
- const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
+ const { InMemoryTransport } = await import("@modelcontextprotocol/core");
+ const { Client } = await import("@modelcontextprotocol/client");
```

Same change in `mcp-auth-e2e.test.ts` and `guards.test.ts`.

## Files NOT affected (no changes needed)

- `types.ts` — our own types, no SDK imports
- `fieldRulesToZod.ts` — uses `zod` only, no SDK
- `defineTool.ts` — pure data builder, no SDK
- `definePrompt.ts` — pure data builder, no SDK
- `buildRequestContext.ts` — Arc internals only
- `resourceToTools.ts` — uses our own types
- `sessionCache.ts` — pure data structure
- `authBridge.ts` — Fastify + Better Auth only
- `schemaResources.ts` — uses `McpServerInstance` interface (our own)
- `guards.ts` — pure functions, no SDK
- `index.ts` — barrel re-exports only
- All user-facing APIs (`defineTool`, `definePrompt`, `guard`, etc.)
- All user-facing types (`McpPluginOptions`, `ToolDefinition`, etc.)

## Summary

| What | Files | Changes |
|------|-------|---------|
| Imports | `createMcpServer.ts`, `mcpPlugin.ts` | Package path |
| Transport rename | `mcpPlugin.ts` | `StreamableHTTPServerTransport` → `NodeStreamableHTTPServerTransport` |
| Schema wrapping | `createMcpServer.ts` | Wrap `tool.inputSchema` in `z.object()` |
| Handler context | `createMcpServer.ts` | `extra.sendNotification` → `ctx.mcpReq.notify` |
| Ambient types | `optional-peers.d.ts` | Module names |
| Test imports | 3 test files | `InMemoryTransport` + `Client` paths |
| **Total** | **5 source + 3 test files** | Mechanical, no logic changes |
