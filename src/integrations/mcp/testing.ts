/**
 * @classytic/arc/mcp/testing — MCP Test Utilities
 *
 * Helpers for testing MCP tool integration without raw JSON-RPC parsing.
 *
 * Runs the real Streamable HTTP transport over an ephemeral loopback port
 * (`127.0.0.1:0`) rather than an in-process shortcut. Two reasons, one forced
 * and one preferred:
 *
 *  - **Forced**: SDK v2 ships `InMemoryTransport` only in
 *    `@modelcontextprotocol/core-internal`, which is `private: true` and not
 *    published, and it exports no `Transport` interface — so there is no
 *    supported way to link a client and server in-process, and no contract to
 *    implement one against. The SDK's own guidance is to point a
 *    `StreamableHTTPClientTransport` at a local server.
 *  - **Preferred**: this exercises the transport arc actually ships in
 *    `mcpPlugin`, instead of a path no production request takes.
 *
 * The cost is a listening socket per harness instead of a linked pair. Always
 * `await close()` — it shuts the client and the HTTP server down together.
 *
 * @example
 * ```typescript
 * import { createTestMcpClient } from '@classytic/arc/mcp/testing';
 *
 * const client = await createTestMcpClient({
 *   pluginOptions: { resources: [productResource] },
 *   auth: { userId: 'test-user', organizationId: 'org-1' },
 * });
 *
 * const tools = await client.listTools();
 * const result = await client.callTool('list_products', { limit: 5 });
 * await client.close();
 * ```
 */

import type { Client } from "@modelcontextprotocol/client";
import { createMcpServer, type McpServerInstance } from "./createMcpServer.js";
import { filterResourcesForMcp } from "./mcpPlugin.js";
import { resourceToTools } from "./resourceToTools.js";
import type { McpAuthResult, McpPluginOptions, ToolDefinition } from "./types.js";

// ============================================================================
// Loopback connection — the ONE place a test client is wired to a server
// ============================================================================

/** An MCP client bound to a live loopback server, plus its teardown. */
export interface ConnectedMcpTestClient {
  /** The connected SDK client — full `listTools` / `callTool` / `listPrompts` surface. */
  client: Client;
  /** Closes the client and the HTTP server. Always await it. */
  close: () => Promise<void>;
}

/**
 * Serve an already-built `McpServer` on an ephemeral loopback port and connect
 * a client to it.
 *
 * Split out from {@link createTestMcpClient} because arc's own MCP suites build
 * a server directly and only need the connection — five of them had each grown a
 * private copy of the same connect helper against the v1 in-memory transport.
 * One implementation, two entry points: this for a server you built, that for
 * one built from resources.
 */
export async function connectMcpTestClient(
  server: McpServerInstance | unknown,
): Promise<ConnectedMcpTestClient> {
  const { randomUUID } = await import("node:crypto");
  const { createServer } = await import("node:http");
  const { NodeStreamableHTTPServerTransport } = await import("@modelcontextprotocol/node");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");

  // Stateful (`sessionIdGenerator` set), matching `mcpPlugin`: the client picks
  // the assigned id up from `mcp-session-id` itself, so no session plumbing here.
  // `handleRequest`'s third argument is the PRE-PARSED body — omitted on purpose
  // so the transport reads the raw stream, which is what bare `node:http` gives.
  const serverTransport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await (server as McpServerInstance).connect(serverTransport);

  const httpServer = createServer((req, res) => {
    void serverTransport.handleRequest(req, res);
  });
  // Port 0 = kernel-assigned, so parallel test files never collide. Bound to
  // 127.0.0.1, never 0.0.0.0 — a test harness must not be reachable off-box.
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    httpServer.close();
    throw new Error("[arc] MCP test harness: HTTP server did not bind a TCP port");
  }

  const client = new Client({ name: "test-client", version: "1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/`)),
  );

  return {
    client,
    /**
     * Client first, THEN the socket. Reversed, the client's in-flight request
     * hangs on a dead server until its own timeout — which reads as a slow test
     * rather than a teardown bug. `httpServer.close()` only stops NEW
     * connections, so keep-alive sockets are destroyed explicitly; without that
     * vitest hangs at end-of-file with no failing assertion.
     */
    async close() {
      await client.close();
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ============================================================================
// Types
// ============================================================================

export interface TestMcpClientOptions {
  /** MCP plugin options (resources, overrides, etc.) — same as mcpPlugin config */
  pluginOptions?: Pick<
    McpPluginOptions,
    | "resources"
    | "overrides"
    | "expose"
    | "exclude"
    | "toolNamePrefix"
    | "extraTools"
    | "extraPrompts"
    | "instructions"
  >;
  /** Auth identity for the test session */
  auth?: McpAuthResult | null;
  /** Server name (default: 'test-mcp') */
  serverName?: string;
}

export interface TestMcpClient {
  /** List all registered tools */
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  /** Call a tool by name */
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
  /** Disconnect and clean up */
  close(): Promise<void>;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Create an in-process MCP test client connected to an Arc MCP server.
 *
 * Pass resources and tools directly — no running Fastify server needed.
 * For HTTP-level integration tests against a running server, use `app.inject()` instead.
 *
 * @example
 * ```typescript
 * const client = await createTestMcpClient({
 *   pluginOptions: { resources: [productResource], extraTools: [myTool] },
 *   auth: { userId: 'test-user', organizationId: 'org-1' },
 * });
 *
 * const tools = await client.listTools();
 * expect(tools.map(t => t.name)).toContain('list_products');
 *
 * const result = await client.callTool('list_products', { limit: 5 });
 * expect(result.isError).toBeFalsy();
 *
 * await client.close();
 * ```
 */
export async function createTestMcpClient(
  options: TestMcpClientOptions = {},
): Promise<TestMcpClient> {
  const pluginOpts: NonNullable<TestMcpClientOptions["pluginOptions"]> = {
    resources: [],
    ...options.pluginOptions,
  };
  // `auth: null` is the documented ANONYMOUS session and must survive: `??`
  // coalesces null as well as undefined, so it silently upgraded every
  // "anonymous is rejected" test into an authenticated `test-user` call —
  // the test passed while proving the opposite of its name. Only an ABSENT
  // `auth` takes the default.
  const auth = options.auth === undefined ? { userId: "test-user" } : options.auth;
  const serverName = options.serverName ?? "test-mcp";

  // Build tools from resources — share `filterResourcesForMcp` with the
  // Fastify plugin so the same `expose` / `include` / `exclude` precedence
  // applies (including the throw on conflicting combinations).
  const overrides = pluginOpts.overrides ?? {};
  const enabledResources = filterResourcesForMcp(pluginOpts.resources ?? [], {
    expose: pluginOpts.expose,
    exclude: pluginOpts.exclude,
  });

  const tools: ToolDefinition[] = enabledResources.flatMap((r) => {
    const resOverrides = overrides[r.name] ?? {};
    return resourceToTools(r, {
      ...resOverrides,
      toolNamePrefix: resOverrides.toolNamePrefix ?? pluginOpts.toolNamePrefix,
    });
  });
  if (pluginOpts.extraTools) tools.push(...pluginOpts.extraTools);

  // Create server
  const authRef = { current: auth };
  const server = await createMcpServer(
    {
      name: serverName,
      version: "1.0.0",
      instructions: pluginOpts.instructions,
      tools,
      prompts: pluginOpts.extraPrompts,
    },
    authRef,
  );

  const { client, close } = await connectMcpTestClient(server);

  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },

    async callTool(name: string, args?: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args ?? {} });
      return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    },

    close,
  };
}
