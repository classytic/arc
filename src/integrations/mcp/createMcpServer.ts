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

import { ArcError } from "../../utils/errors.js";
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
    // Resolve duplicates BEFORE handing tools to the SDK. The MCP SDK
    // throws an opaque `Tool already registered` error from deep inside
    // `McpServer.registerTool` with no source attribution — every host
    // that hit it (sniffer's `softDelete + actions.restore` collision is
    // the canonical example) spent the same evening grepping for the
    // duplicate name. arc now resolves the common case (preset vs user)
    // automatically and throws a typed error naming BOTH sources for
    // everything else.
    const resolved = resolveToolCollisions(config.tools);
    for (const tool of resolved) registerTool(server, tool, authRef);
  }
  if (config.prompts) {
    for (const prompt of config.prompts) registerPrompt(server, prompt);
  }

  return server as unknown as McpServerInstance;
}

// ============================================================================
// Tool-name collision resolution
// ============================================================================

/**
 * Detect and resolve duplicate MCP tool names across the assembled tool list.
 *
 * Two outcomes:
 *
 *  1. **Auto-namespace** — when one tool's `source` carries a `preset:<name>`
 *     prefix and the other doesn't, the preset tool is renamed to
 *     `<presetName>_<originalName>` (e.g. softDelete's `restore_post`
 *     becomes `softdelete_restore_post` when the user defines
 *     `actions.restore`). The user's tool wins the canonical name because
 *     it's the more-specific intent.
 *
 *  2. **Typed throw** — every other collision (two user actions, two
 *     custom routes, two presets) raises `ArcError('arc.mcp.tool_name_collision')`
 *     naming both sources so the host's stack trace points at the
 *     resource definitions, not the MCP SDK internals.
 *
 * Exported for the testing harness so collision behaviour can be exercised
 * without a full server boot.
 */
export function resolveToolCollisions(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition[]>();
  for (const t of tools) {
    const list = byName.get(t.name);
    if (list) list.push(t);
    else byName.set(t.name, [t]);
  }

  const out: ToolDefinition[] = [];
  for (const [name, list] of byName) {
    const [first, second, ...rest] = list;
    if (!first) continue; // unreachable — every map entry has ≥1 item
    if (!second) {
      out.push(first);
      continue;
    }

    // Two-way collision — common case. Three-way+ falls through to throw
    // because auto-resolution becomes ambiguous (which preset wins?).
    if (rest.length === 0) {
      const firstIsPreset = first.source?.startsWith("preset:") ?? false;
      const secondIsPreset = second.source?.startsWith("preset:") ?? false;
      if (firstIsPreset !== secondIsPreset) {
        const preset = firstIsPreset ? first : second;
        const user = firstIsPreset ? second : first;
        const presetName = preset.source?.split(":")[1] ?? "preset";
        const namespaced = `${presetName.toLowerCase()}_${name}`;
        out.push({ ...preset, name: namespaced });
        out.push(user);
        continue;
      }
    }

    throw new ArcError(
      `MCP tool name '${name}' is registered by ${list.length} sources: ${list
        .map((t) => t.source ?? "(unknown)")
        .join(
          ", ",
        )}. Rename one of the sources (e.g. via 'actions.${name}' → 'actions.${name}V2', ` +
        "or pass 'names: { [op]: \"custom_name\" }' in mcpPlugin overrides) so each tool has a unique name.",
      { code: "arc.mcp.tool_name_collision", statusCode: 500 },
    );
  }

  return out;
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
