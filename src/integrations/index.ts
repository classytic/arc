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

// Streamline (workflow orchestration)
export type {
  StreamlinePluginOptions,
  WorkflowLike,
  WorkflowRunLike,
} from './streamline.js';

// WebSocket (real-time communication)
export type {
  WebSocketPluginOptions,
  WebSocketClient,
  WebSocketMessage,
} from './websocket.js';

// Event Gateway (unified SSE + WebSocket)
export type { EventGatewayOptions } from './event-gateway.js';

// Jobs (background processing)
export type {
  JobsPluginOptions,
  JobDefinition,
  JobMeta,
  JobDispatchOptions,
  JobDispatcher,
  QueueStats,
} from './jobs.js';
