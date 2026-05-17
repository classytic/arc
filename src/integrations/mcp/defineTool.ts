/**
 * @classytic/arc — defineTool()
 *
 * Type-safe MCP tool builder. Returns a ToolDefinition (plain data).
 * The SDK uses flat Zod shapes — pass `{ name: z.string() }`, not z.object().
 *
 * @example
 * ```typescript
 * import { defineTool } from '@classytic/arc/mcp';
 * import { z } from 'zod';
 *
 * const weatherTool = defineTool('get_weather', {
 *   description: 'Get current weather for a city',
 *   input: {
 *     city: z.string().describe('City name'),
 *     units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
 *   },
 *   annotations: { readOnlyHint: true, openWorldHint: true },
 *   handler: async ({ city, units }) => ({
 *     content: [{ type: 'text', text: JSON.stringify(await getWeather(city, units)) }],
 *   }),
 * });
 * ```
 */

import type { z } from "zod";
import type {
  CallToolResult,
  McpAuthResult,
  ToolAnnotations,
  ToolContext,
  ToolDefinition,
} from "./types.js";

/**
 * defineTool() config — uses flat Zod shapes for SDK compatibility.
 *
 * The `TSession` parameter widens `ctx.session` to a host-specific shape.
 * Pass an interface that extends `McpAuthResult` (or one that omits it
 * entirely for custom auth resolvers) to drop the `as any` casts that
 * pre-2.15.5 handlers needed when reading session fields.
 */
export interface DefineToolConfig<
  TInput extends Record<string, z.ZodTypeAny>,
  TSession = McpAuthResult,
> {
  description: string;
  title?: string;
  /** Flat Zod shape: `{ name: z.string(), age: z.number() }` */
  input?: TInput;
  /** Flat Zod shape for structured output */
  output?: Record<string, z.ZodTypeAny>;
  annotations?: ToolAnnotations;
  handler: (
    input: { [K in keyof TInput]: z.infer<TInput[K]> },
    ctx: ToolContext<TSession>,
  ) => Promise<CallToolResult>;
}

/**
 * Define a type-safe MCP tool.
 *
 * @param name - Tool name (snake_case recommended)
 * @param config - Tool description, input schema, annotations, handler
 */
export function defineTool<TInput extends Record<string, z.ZodTypeAny>, TSession = McpAuthResult>(
  name: string,
  config: DefineToolConfig<TInput, TSession>,
): ToolDefinition<TSession> {
  return {
    name,
    description: config.description,
    title: config.title,
    inputSchema: config.input as ToolDefinition["inputSchema"],
    outputSchema: config.output,
    annotations: config.annotations,
    handler: config.handler as ToolDefinition<TSession>["handler"],
  };
}
