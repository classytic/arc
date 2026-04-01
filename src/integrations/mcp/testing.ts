/**
 * @classytic/arc/mcp/testing — MCP Test Utilities
 *
 * Helpers for testing MCP tool integration without raw JSON-RPC parsing.
 * Uses the MCP SDK's InMemoryTransport for fast, in-process testing.
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

import { createMcpServer, type McpServerInstance } from "./createMcpServer.js";
import { resourceToTools } from "./resourceToTools.js";
import type { McpAuthResult, McpPluginOptions, ToolDefinition } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface TestMcpClientOptions {
  /** MCP plugin options (resources, overrides, etc.) — same as mcpPlugin config */
  pluginOptions?: Pick<
    McpPluginOptions,
    | "resources"
    | "overrides"
    | "include"
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
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const pluginOpts: NonNullable<TestMcpClientOptions["pluginOptions"]> = {
    resources: [],
    ...options.pluginOptions,
  };
  const auth = options.auth ?? { userId: "test-user" };
  const serverName = options.serverName ?? "test-mcp";

  // Build tools from resources
  const overrides = pluginOpts.overrides ?? {};
  let enabledResources = pluginOpts.resources ?? [];
  if (pluginOpts.include) {
    const includeSet = new Set(pluginOpts.include);
    enabledResources = enabledResources.filter((r) => includeSet.has(r.name));
  } else if (pluginOpts.exclude) {
    const excludeSet = new Set(pluginOpts.exclude);
    enabledResources = enabledResources.filter((r) => !excludeSet.has(r.name));
  }

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

  // Connect via InMemoryTransport
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0" });
  await Promise.all([
    client.connect(clientTransport),
    (server as McpServerInstance).connect(serverTransport),
  ]);

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

    async close() {
      await client.close();
    },
  };
}
