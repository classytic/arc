/**
 * AI SDK tool → MCP tool bridge.
 *
 * Lets you expose the same tool builder over both transports:
 *   - AI SDK `tool()` — used by in-process agents
 *   - MCP `defineTool()` — exposed at `/mcp` to external agents (Claude, Cursor, etc.)
 *
 * The bridge is declarative: describe how to rebuild the AI SDK tool from an
 * MCP session (which provides per-request auth/scope), and the bridge handles:
 *   • Auth guard (`isAuthenticated`)
 *   • Optional custom guards (scope/role checks)
 *   • Envelope translation (AI SDK result → MCP `{ content, isError }`)
 *   • Error mapping (thrown errors, `{ error: '...' }` results)
 *
 * @example
 * ```typescript
 * import { bridgeToMcp, getUserId, type McpBridge } from '@classytic/arc/mcp';
 * import { tool } from 'ai';
 * import { z } from 'zod';
 *
 * function buildTriggerJobTool(companyId: string) {
 *   return tool({
 *     description: 'Trigger a job.',
 *     inputSchema: z.object({ phase: z.enum(['investigate', 'fix']) }),
 *     execute: async (input) => ({ jobId: `${companyId}-${Date.now()}` }),
 *   });
 * }
 *
 * export const triggerJobBridge: McpBridge = {
 *   name: 'trigger_job',
 *   description: 'Trigger a job.',
 *   inputSchema: { phase: z.enum(['investigate', 'fix']) },
 *   annotations: { destructiveHint: true },
 *   buildTool: (ctx) => buildTriggerJobTool(getUserId(ctx) ?? ''),
 * };
 *
 * extraTools: [bridgeToMcp(triggerJobBridge)]
 * ```
 */

import type { z } from "zod";
import { defineTool } from "./defineTool.js";
import { denied, isAuthenticated } from "./guards.js";
import type { ToolAnnotations, ToolContext, ToolDefinition } from "./types.js";

/** Minimal AI SDK tool shape we need to invoke. */
interface AiSdkExecutable {
  execute: (input: unknown, options?: unknown) => Promise<unknown>;
}

export interface McpBridge {
  /** MCP tool name. */
  name: string;
  /** LLM-facing description. */
  description: string;
  /** Zod input schema — matches the AI SDK tool's inputSchema. */
  inputSchema: Record<string, z.ZodType>;
  /** MCP annotations — same shape as `defineTool`. */
  annotations?: ToolAnnotations;
  /**
   * Build the AI SDK tool from MCP session context. Called per-request.
   * The caller injects deps (companyId, projectId, etc.) from `ctx`.
   */
  buildTool: (ctx: ToolContext) => AiSdkExecutable;
  /**
   * Optional pre-execution guard. Return an error message to reject, or
   * `null` to proceed. Runs after `isAuthenticated`.
   */
  guard?: (ctx: ToolContext) => string | null;
}

type McpResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Serialize an AI SDK tool result into MCP's text-content envelope. */
function toMcpEnvelope(result: unknown): McpResponse {
  // AI SDK tools often return `{ error: 'msg' }` on recoverable failures —
  // preserve that as an MCP error so the external agent sees it.
  if (result && typeof result === "object" && "error" in result) {
    const msg = (result as { error: unknown }).error;
    return {
      content: [{ type: "text", text: typeof msg === "string" ? msg : JSON.stringify(msg) }],
      isError: true,
    };
  }

  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Convert a McpBridge into a registered MCP tool. */
export function bridgeToMcp(bridge: McpBridge): ToolDefinition {
  return defineTool(bridge.name, {
    description: bridge.description,
    input: bridge.inputSchema,
    annotations: bridge.annotations,
    handler: async (input, ctx) => {
      if (!isAuthenticated(ctx)) return denied("Authentication required");

      if (bridge.guard) {
        const reason = bridge.guard(ctx);
        if (reason) return denied(reason);
      }

      try {
        const tool = bridge.buildTool(ctx);
        const result = await tool.execute(input as unknown);
        return toMcpEnvelope(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return denied(message);
      }
    },
  });
}

// ── Registry helpers ──

export interface BuildMcpToolsFromBridgesOptions {
  /** If set, only bridges whose `name` is in this array are registered. */
  include?: string[];
  /** If set, bridges whose `name` is in this array are skipped. */
  exclude?: string[];
}

/**
 * Take a list of McpBridge objects and produce a ready-to-register MCP tool
 * array, with optional include/exclude filtering for per-environment config.
 *
 * @example
 * ```typescript
 * // All bridges
 * extraTools: [...buildMcpToolsFromBridges(allBridges)]
 *
 * // Read-only deployment — hide destructive tools
 * extraTools: [...buildMcpToolsFromBridges(allBridges, { exclude: ['trigger_job'] })]
 * ```
 */
export function buildMcpToolsFromBridges(
  bridges: readonly McpBridge[],
  options: BuildMcpToolsFromBridgesOptions = {},
): ToolDefinition[] {
  return bridges
    .filter((bridge) => {
      if (options.include) return options.include.includes(bridge.name);
      if (options.exclude) return !options.exclude.includes(bridge.name);
      return true;
    })
    .map(bridgeToMcp);
}
