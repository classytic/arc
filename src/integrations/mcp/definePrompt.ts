/**
 * @classytic/arc — definePrompt()
 *
 * Type-safe MCP prompt builder. Returns a PromptDefinition (plain data).
 *
 * @example
 * ```typescript
 * import { definePrompt } from '@classytic/arc/mcp';
 * import { z } from 'zod';
 *
 * const calendarPrompt = definePrompt('content_calendar', {
 *   description: 'Plan a content calendar for the week',
 *   args: {
 *     platforms: z.string().describe('Comma-separated platforms'),
 *     theme: z.string().optional().describe('Content theme'),
 *   },
 *   handler: ({ platforms, theme }) => ({
 *     messages: [{
 *       role: 'user',
 *       content: {
 *         type: 'text',
 *         text: `Plan a content calendar for ${platforms}${theme ? ` with theme "${theme}"` : ''}.`,
 *       },
 *     }],
 *   }),
 * });
 * ```
 */

import type { z } from "zod";
import type { PromptDefinition, PromptResult } from "./types.js";

/** definePrompt() config */
export interface DefinePromptConfig<TArgs extends Record<string, z.ZodTypeAny>> {
  description: string;
  title?: string;
  /** Flat Zod shape for prompt arguments */
  args?: TArgs;
  handler: (args: { [K in keyof TArgs]: z.infer<TArgs[K]> }) => PromptResult;
}

/**
 * Define a type-safe MCP prompt.
 *
 * @param name - Prompt name (snake_case recommended)
 * @param config - Description, args schema, handler
 */
export function definePrompt<TArgs extends Record<string, z.ZodTypeAny>>(
  name: string,
  config: DefinePromptConfig<TArgs>,
): PromptDefinition {
  return {
    name,
    description: config.description,
    title: config.title,
    argsSchema: config.args as PromptDefinition["argsSchema"],
    handler: config.handler as PromptDefinition["handler"],
  };
}
