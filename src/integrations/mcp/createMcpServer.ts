/**
 * @classytic/arc — createMcpServer()
 *
 * Level 2 — Declarative MCP server factory over `server.registerTool()` /
 * `server.registerPrompt()`. Hosts keep the flat-shape ergonomic
 * (`{ name: z.string() }`); arc wraps it in `z.object()` before registering,
 * because the SDK's raw-shape overloads are deprecated.
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
  McpServer,
  CallToolResult as SdkCallToolResult,
  GetPromptResult as SdkGetPromptResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { ArcError } from "../../utils/errors.js";
import type {
  CreateMcpServerConfig,
  McpAuthResult,
  McpToolLogger,
  PromptDefinition,
  ToolContext,
  ToolDefinition,
  ToolInputSchema,
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
): Promise<McpServer> {
  const { McpServer: McpServerCtor } = await import("@modelcontextprotocol/server");

  const server = new McpServerCtor(
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
    for (const tool of resolved) registerTool(server, tool, authRef, config.logger);
  }
  if (config.prompts) {
    for (const prompt of config.prompts) registerPrompt(server, prompt);
  }

  return server;
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
// McpServer type
// ============================================================================

/**
 * The SDK's `McpServer`. Kept as a named alias because hosts import it from
 * `@classytic/arc/mcp`; it was a hand-written structural subset, which hid the
 * real signatures (and their deprecations) from the type checker.
 */
export type McpServerInstance = McpServer;

// ============================================================================
// Registration
// ============================================================================

/**
 * Flat shape → `z.object()`. A whole schema (anything carrying
 * `~standard`, e.g. `z.strictObject(...)`) is registered as-is. The SDK still
 * accepts a raw shape, but only through overloads marked deprecated.
 */
function toObjectSchema(schema: ToolInputSchema | undefined): z.ZodType | undefined {
  if (schema === undefined) return undefined;
  if ("~standard" in schema) return schema as z.ZodType;
  return z.object(schema as Record<string, z.ZodType>);
}

/**
 * Register a ToolDefinition using `server.registerTool()`.
 *
 * A tool WITHOUT an input schema is registered with a one-argument callback:
 * the SDK calls such handlers as `(ctx)`, not `(args, ctx)`. Registering the
 * two-argument form there handed the SDK context to the tool as its input and
 * left `ctx.extra` / `ctx.log` unbound.
 */
function registerTool(
  server: McpServer,
  tool: ToolDefinition,
  authRef?: AuthRef,
  logger?: McpToolLogger,
): void {
  /**
   * Server-side, not `ctx.mcpReq.log`: protocol 2026-07-28 deprecates logging
   * to the client (SEP-2577 — "migrate to stderr or OpenTelemetry"), and the
   * SDK drops those lines anyway unless the server declares `logging` and the
   * request carries a `logLevel` envelope key.
   */
  const log: ToolContext["log"] = async (level, message) => {
    logger?.[level === "warning" ? "warn" : level]({ mcpTool: tool.name }, message);
  };
  const run = (input: Record<string, unknown>, mcpCtx: ServerContext) => {
    const ctx: ToolContext = {
      session: authRef?.current ?? null,
      log,
      extra: mcpCtx,
    };
    return tool.handler(input, ctx) as Promise<SdkCallToolResult>;
  };

  const inputSchema = toObjectSchema(tool.inputSchema);
  const config = {
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.outputSchema ? { outputSchema: z.object(tool.outputSchema) } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };

  if (inputSchema) {
    server.registerTool(tool.name, { ...config, inputSchema }, (input, mcpCtx) =>
      run(input as Record<string, unknown>, mcpCtx),
    );
  } else {
    server.registerTool(tool.name, config, (mcpCtx) => run({}, mcpCtx));
  }
}

/**
 * Register a PromptDefinition using `server.registerPrompt()`. Same arity rule
 * as tools: an args-less prompt's callback receives only the SDK context.
 */
function registerPrompt(server: McpServer, prompt: PromptDefinition): void {
  const config = {
    ...(prompt.title ? { title: prompt.title } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
  };
  const render = (args: Record<string, unknown>) =>
    prompt.handler(args) as unknown as SdkGetPromptResult;

  if (prompt.argsSchema) {
    server.registerPrompt(
      prompt.name,
      { ...config, argsSchema: z.object(prompt.argsSchema) },
      (args) => render(args as Record<string, unknown>),
    );
  } else {
    server.registerPrompt(prompt.name, config, () => render({}));
  }
}
