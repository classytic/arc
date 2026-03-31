/**
 * @classytic/arc/mcp — MCP Integration
 *
 * Arc helpers for building MCP servers — from zero-config auto-generation
 * to fully custom tool definitions.
 *
 * Two levels:
 * - Level 1: `mcpPlugin`        → Auto-generate tools from defineResource()
 * - Level 2: `createMcpServer`  → Declarative tool/resource/prompt config
 *
 * Peer dependencies (optional, loaded only when this module is imported):
 *   @modelcontextprotocol/sdk >= 1.28.0
 *   zod (any version already in your project)
 *
 * @example
 * ```typescript
 * // Level 1 — zero-config
 * import { mcpPlugin } from '@classytic/arc/mcp';
 * await app.register(mcpPlugin, { resources, auth: false });
 *
 * // Level 2 — custom tools
 * import { createMcpServer, defineTool } from '@classytic/arc/mcp';
 * import { z } from 'zod';
 *
 * const server = await createMcpServer({
 *   name: 'my-api',
 *   tools: [
 *     defineTool('ping', {
 *       description: 'Ping',
 *       handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
 *     }),
 *   ],
 * });
 * ```
 */

// Factory (Level 2)
export { type AuthRef, createMcpServer, type McpServerInstance } from "./createMcpServer.js";
export { type DefinePromptConfig, definePrompt } from "./definePrompt.js";

// Builders — user-facing API for custom tools/prompts
export { type DefineToolConfig, defineTool } from "./defineTool.js";
// Utilities
export {
  type FieldRuleEntry,
  type FieldRulesToZodOptions,
  fieldRulesToZod,
} from "./fieldRulesToZod.js";
// Guards — permission helpers for custom MCP tools
export {
  customGuard,
  denied,
  getOrgId,
  getUserId,
  guard,
  hasOrg,
  isAuthenticated,
  isOrg,
  type McpGuard,
  requireAuth,
  requireOrg,
  requireOrgId,
  requireRole,
} from "./guards.js";
// Plugin (Level 1)
export { mcpPlugin } from "./mcpPlugin.js";
export { type ResourceToToolsConfig, resourceToTools } from "./resourceToTools.js";

// Types
export type {
  BetterAuthHandler,
  CallToolResult,
  CreateMcpServerConfig,
  CrudOperation,
  McpAuthResolver,
  McpAuthResult,
  McpPluginOptions,
  McpResourceConfig,
  PromptDefinition,
  PromptResult,
  ToolAnnotations,
  ToolContext,
  ToolDefinition,
} from "./types.js";
