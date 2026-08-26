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

// AI SDK bridge — expose AI SDK tool builders as MCP tools
export {
  type BuildMcpToolsFromBridgesOptions,
  bridgeToMcp,
  buildMcpToolsFromBridges,
  type McpBridge,
} from "./aiSdkBridge.js";
// Better Auth API-key → MCP resolver
export {
  type CreateMcpAuthFromBetterAuthApiKeyOptions,
  createMcpAuthFromBetterAuthApiKey,
} from "./betterAuthApiKey.js";
// Factory (Level 2) + collision resolution
export {
  type AuthRef,
  createMcpServer,
  type McpServerInstance,
  resolveToolCollisions,
} from "./createMcpServer.js";
// CRUD description helpers — public surface for function-form description
// overrides (`descriptions: { list: (meta) => ... }`).
export {
  defaultCrudDescription,
  resolveCrudDescription,
} from "./crud-tools.js";
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
// Non-HTTP controller invocation — shared pipeline for MCP tools, jobs,
// workflow steps. Eliminates the synthetic-context shim every caller used
// to reinvent.
export {
  buildRequestContext,
  type InvokeControllerOptions,
  invokeController,
  type McpOperation,
  mcpHandlerAdapter,
} from "./invokeController.js";
// Plugin (Level 1)
export { filterResourcesForMcp, mcpPlugin } from "./mcpPlugin.js";
export {
  type DispatchOptions,
  dispatchRealtimeToolCall,
  type RealtimeToolCall,
  type RealtimeToolResponse,
} from "./realtimeBridge.js";
export { type ResourceToToolsConfig, resourceToTools } from "./resourceToTools.js";
// Error/success helpers — re-exported so custom tools can produce the
// canonical CallToolResult shape without depending on an internal subpath.
export {
  permissionDeniedResult,
  toCallToolError,
  toCallToolResult,
  toCallToolSuccess,
} from "./tool-helpers.js";

// Types
export type {
  BetterAuthHandler,
  CallToolResult,
  CreateMcpServerConfig,
  CrudDescriptionMeta,
  CrudDescriptionOverride,
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
