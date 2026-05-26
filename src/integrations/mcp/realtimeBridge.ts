/**
 * Realtime tool bridge — dispatches `LiveServerToolCall`-shaped frames
 * (LiveKit Agents, Gemini Live, OpenAI Realtime) through arc's existing
 * MCP tool registry.
 *
 * Why bridge instead of re-implement: the MCP tool registry already
 * owns input schema validation (Zod), handler invocation, session
 * binding, and the response envelope shape. Realtime AI sessions
 * speak a slightly different wire format (`{toolCalls:[{id,name,args}]}`)
 * but the SEMANTICS are identical — execute by name, validate args,
 * return result by id.
 *
 * Shape compatibility:
 *
 *   - LiveKit Agents / Gemini Live wire shape:
 *       { toolCalls: [{ id, name, arguments }] }
 *
 *   - js-genai sendToolResponse shape:
 *       { functionResponses: [{ id, name, response }] }
 *
 *   - arc MCP CallToolResult:
 *       { content: [{type:'text', text}], isError?, structuredContent? }
 *
 * The bridge normalizes between these so a single `defineTool('get_weather', ...)`
 * declaration powers BOTH the MCP server AND realtime AI sessions
 * without a duplicate handler.
 *
 * Usage:
 *
 *   import { dispatchRealtimeToolCall } from '@classytic/arc/mcp';
 *
 *   await app.register(websocketPlugin, {
 *     onMessage: async (client, msg) => {
 *       if (msg.type === 'tool_call' && Array.isArray(msg.toolCalls)) {
 *         const responses = await dispatchRealtimeToolCall(myTools, msg.toolCalls, {
 *           session: client.userId ? { userId: client.userId } : null,
 *         });
 *         client.queue?.send(JSON.stringify({ type: 'tool_response', functionResponses: responses }));
 *       }
 *     },
 *   });
 */

import type { z } from "zod";
import type { CallToolResult, ToolContext, ToolDefinition } from "./types.js";

/**
 * Inbound tool-call shape — accepts both LiveKit Agents (`arguments`)
 * and OpenAI Realtime (`arguments_json` string) variants. Other realtime
 * vendors stay flexible because we only look at the canonical fields.
 */
export interface RealtimeToolCall {
  id: string;
  name: string;
  /** Parsed object form. Preferred over `arguments_json`. */
  arguments?: Record<string, unknown>;
  /** JSON-string form (OpenAI Realtime tools). Parsed if `arguments` is absent. */
  arguments_json?: string;
}

/** Outbound shape — mirrors js-genai's sendToolResponse. */
export interface RealtimeToolResponse {
  id: string;
  name: string;
  /** Tool result — `content` from the MCP CallToolResult, normalized to plain JSON. */
  response: Record<string, unknown>;
  /** Surfaces tool-side errors so the model can recover. */
  isError?: boolean;
}

export interface DispatchOptions<TSession = unknown> {
  session?: TSession | null;
  log?: ToolContext<TSession>["log"];
  /** Forwarded into `ctx.extra` for advanced handlers. */
  extra?: Record<string, unknown>;
}

/**
 * Dispatch a batch of tool calls through the host's MCP tool registry.
 *
 * Returns the response array in the same order as the input. Each
 * response carries either the tool's `content` (success path) or a
 * `{isError:true, error:{message,...}}` shape (validation failure or
 * handler throw). The realtime client uses the `id` to correlate
 * responses to the original calls.
 */
export async function dispatchRealtimeToolCall<TSession = unknown>(
  tools: readonly ToolDefinition[],
  calls: readonly RealtimeToolCall[],
  opts: DispatchOptions<TSession> = {},
): Promise<RealtimeToolResponse[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const noopLog: ToolContext<TSession>["log"] = async () => {};
  const baseCtx: ToolContext<TSession> = {
    session: (opts.session ?? null) as TSession | null,
    log: opts.log ?? noopLog,
    extra: opts.extra ?? {},
  };

  // Dispatch in parallel — realtime sessions typically batch independent
  // calls (e.g. fetch weather + search news in one turn). Serial would
  // bottleneck on a slow upstream. Errors are caught per-call so one
  // failure doesn't poison the others.
  const settled = await Promise.allSettled(
    calls.map((call) => dispatchOne(byName.get(call.name), call, baseCtx)),
  );
  return settled.map((s, i) => {
    const call = calls[i];
    if (!call) {
      // Unreachable — Promise.allSettled preserves input order, so every
      // result index maps to an input index. Defensive in case the input
      // array is mutated mid-flight.
      return {
        id: "unknown",
        name: "unknown",
        isError: true,
        response: { error: "missing call slot" },
      };
    }
    if (s.status === "fulfilled") return s.value;
    return {
      id: call.id,
      name: call.name,
      isError: true,
      response: { error: s.reason instanceof Error ? s.reason.message : String(s.reason) },
    };
  });
}

async function dispatchOne<TSession>(
  def: ToolDefinition | undefined,
  call: RealtimeToolCall,
  ctx: ToolContext<TSession>,
): Promise<RealtimeToolResponse> {
  if (!def) {
    return {
      id: call.id,
      name: call.name,
      isError: true,
      response: { error: `unknown tool: ${call.name}` },
    };
  }
  // Parse args from either parsed-object or JSON-string form.
  let parsedArgs: Record<string, unknown> = call.arguments ?? {};
  if (!call.arguments && typeof call.arguments_json === "string") {
    try {
      parsedArgs = JSON.parse(call.arguments_json) as Record<string, unknown>;
    } catch {
      return {
        id: call.id,
        name: call.name,
        isError: true,
        response: { error: "arguments_json is not valid JSON" },
      };
    }
  }

  // Zod input validation — the same path the MCP server uses. We
  // construct an ad-hoc validator from the flat shape so we don't
  // duplicate logic.
  if (def.inputSchema) {
    const fieldErrors: string[] = [];
    const validated: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(def.inputSchema)) {
      const result = (schema as z.ZodTypeAny).safeParse(parsedArgs[key]);
      if (!result.success) {
        fieldErrors.push(`${key}: ${result.error.message}`);
      } else {
        validated[key] = result.data;
      }
    }
    if (fieldErrors.length > 0) {
      return {
        id: call.id,
        name: call.name,
        isError: true,
        response: { error: "argument validation failed", fields: fieldErrors },
      };
    }
    parsedArgs = validated;
  }

  const result: CallToolResult = await (
    def.handler as (
      args: Record<string, unknown>,
      ctx: ToolContext<TSession>,
    ) => Promise<CallToolResult>
  )(parsedArgs, ctx);

  return {
    id: call.id,
    name: call.name,
    isError: result.isError,
    response: normalizeResult(result),
  };
}

/**
 * Normalize an MCP `CallToolResult` into a flat JSON object the realtime
 * wire can carry. Prefers structuredContent; falls back to concatenated
 * text content.
 */
function normalizeResult(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent) {
    return result.structuredContent as Record<string, unknown>;
  }
  const texts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }
  // Try to parse the joined text as JSON — realtime models usually
  // produce JSON anyway. Fall back to a `{text}` wrapper if not.
  if (texts.length > 0) {
    const joined = texts.join("");
    try {
      const parsed: unknown = JSON.parse(joined);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
    return { text: joined };
  }
  return {};
}
