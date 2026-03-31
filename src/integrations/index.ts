/**
 * Arc Integrations
 *
 * Pluggable adapters for extending Arc with external systems.
 * Each integration is available as a dedicated subpath import:
 *
 *   import { streamlinePlugin } from '@classytic/arc/integrations/streamline';
 *   import { websocketPlugin } from '@classytic/arc/integrations/websocket';
 *   import { jobsPlugin } from '@classytic/arc/integrations/jobs';
 *
 * This barrel re-exports types only — no runtime code is pulled in.
 * Import the actual plugins from their dedicated subpaths.
 */

// Event Gateway (unified SSE + WebSocket)
export type { EventGatewayOptions } from "./event-gateway.js";
// Jobs (background processing)
export type {
  JobDefinition,
  JobDispatcher,
  JobDispatchOptions,
  JobMeta,
  JobsPluginOptions,
  QueueStats,
} from "./jobs.js";
// MCP (Model Context Protocol)
// Runtime: import from '@classytic/arc/mcp'
export type {
  BetterAuthHandler,
  CallToolResult,
  CreateMcpServerConfig,
  CrudOperation,
  McpAuthResult,
  McpPluginOptions,
  McpResourceConfig,
  PromptDefinition,
  ToolAnnotations,
  ToolContext,
  ToolDefinition,
} from "./mcp/types.js";
// Streamline (workflow orchestration)
export type {
  StreamlinePluginOptions,
  WorkflowLike,
  WorkflowRunLike,
} from "./streamline.js";
// Webhooks (outbound customer subscriptions)
// Runtime: import from '@classytic/arc/integrations/webhooks'
export type {
  WebhookDeliveryRecord,
  WebhookManager,
  WebhookPluginOptions,
  WebhookStore,
  WebhookSubscription,
} from "./webhooks.js";

// WebSocket (real-time communication)
export type {
  WebSocketClient,
  WebSocketMessage,
  WebSocketPluginOptions,
} from "./websocket.js";
