/**
 * @classytic/arc — createMcpServer()
 *
 * Level 2 — Declarative MCP server factory.
 * Uses `server.registerTool()` / `server.registerPrompt()` (official SDK API)
 * with flat inputSchema shapes — no z.object() wrapping, no Zod version hacks.
 *
 * @example
 * ```typescript
 * import { createMcpServer, defineTool } from '@classytic/arc/mcp';
 * import { z } from 'zod';
 *
 * const server = await createMcpServer({
 *   name: 'my-api',
 *   version: '1.0.0',
 *   tools: [
 *     defineTool('greet', {
 *       description: 'Say hello',
 *       input: { name: z.string() },
 *       handler: async ({ name }) => ({ content: [{ type: 'text', text: `Hello ${name}` }] }),
 *     }),
 *   ],
 * });
 * ```
 */

import type {
  CreateMcpServerConfig,
  McpAuthResult,
  PromptDefinition,
  ToolContext,
  ToolDefinition,
} from "./types.js";

/**
 * Mutable auth ref — updated per-request by mcpPlugin.
 * Tool handlers read from this to get the current request's auth context.
 */
export interface AuthRef {
  current: McpAuthResult | null;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Create a configured MCP server from declarative config.
 *
 * @param config - Server name, version, tools, prompts
 * @returns McpServer instance (not yet connected to a transport)
 */
export async function createMcpServer(
  config: CreateMcpServerConfig,
  authRef?: AuthRef,
): Promise<McpServerInstance> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

  const server = new McpServer(
    { name: config.name, version: config.version ?? "1.0.0" },
    config.instructions ? { instructions: config.instructions } : undefined,
  );

  if (config.tools) {
    for (const tool of config.tools) registerTool(server, tool, authRef);
  }
  if (config.prompts) {
    for (const prompt of config.prompts) registerPrompt(server, prompt);
  }

  return server as unknown as McpServerInstance;
}

// ============================================================================
// McpServer shape (minimal interface to avoid importing SDK types)
// ============================================================================

/** Minimal interface for McpServer — avoids hard SDK type dependency */
export interface McpServerInstance {
  connect: (transport: unknown) => Promise<void>;
  registerTool: (
    name: string,
    config: Record<string, unknown>,
    handler: (input: Record<string, unknown>, extra: Record<string, unknown>) => unknown,
  ) => unknown;
  registerPrompt: (
    name: string,
    config: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => unknown,
  ) => void;
  resource: (...args: unknown[]) => void;
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register a ToolDefinition using `server.registerTool()`.
 *
 * The inputSchema is passed as a flat Zod shape `{ field: z.string() }` —
 * the SDK wraps it in z.object() internally. This avoids the Zod v3/v4-mini
 * version mismatch entirely.
 */
function registerTool(server: unknown, tool: ToolDefinition, authRef?: AuthRef): void {
  const srv = server as McpServerInstance;

  const config: Record<string, unknown> = {};
  if (tool.title) config.title = tool.title;
  if (tool.description) config.description = tool.description;
  if (tool.inputSchema) config.inputSchema = tool.inputSchema;
  if (tool.outputSchema) config.outputSchema = tool.outputSchema;
  if (tool.annotations) config.annotations = tool.annotations;

  srv.registerTool(
    tool.name,
    config,
    (input: Record<string, unknown>, extra: Record<string, unknown>) => {
      const ctx: ToolContext = {
        session: authRef?.current ?? null,
        log: async (level, message) => {
          try {
            const notify = extra?.sendNotification as
              | ((...a: unknown[]) => Promise<void>)
              | undefined;
            if (notify)
              await notify({ method: "notifications/message", params: { level, data: message } });
          } catch {
            /* best-effort */
          }
        },
        extra,
      };
      return tool.handler(input, ctx);
    },
  );
}

/** Register a PromptDefinition using `server.registerPrompt()` */
function registerPrompt(server: unknown, prompt: PromptDefinition): void {
  const srv = server as McpServerInstance;

  const config: Record<string, unknown> = {};
  if (prompt.title) config.title = prompt.title;
  if (prompt.description) config.description = prompt.description;
  if (prompt.argsSchema) config.argsSchema = prompt.argsSchema;

  srv.registerPrompt(prompt.name, config, (args: Record<string, unknown>) => prompt.handler(args));
}
