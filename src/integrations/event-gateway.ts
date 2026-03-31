/**
 * @classytic/arc — Event Gateway
 *
 * Unified real-time configuration point that wires SSE and WebSocket with
 * shared auth, org-scoping, and policy enforcement. Replaces the need to
 * configure SSE and WebSocket plugins independently.
 *
 *   import { eventGatewayPlugin } from '@classytic/arc/integrations/event-gateway';
 *
 *   await fastify.register(eventGatewayPlugin, {
 *     auth: true,
 *     orgScoped: true,
 *     roomPolicy: (client, room) => ['product', 'order'].includes(room),
 *     sse: { path: '/api/events', patterns: ['order.*', 'product.*'] },
 *     ws: { path: '/ws', resources: ['product', 'order'] },
 *   });
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { DomainEvent } from "../events/EventTransport.js";
import type { WebSocketClient, WebSocketMessage } from "./websocket.js";

// ============================================================================
// Types
// ============================================================================

export interface EventGatewayOptions {
  /** Require auth for all real-time connections (default: true) */
  auth?: boolean;
  /** Custom auth function for WebSocket upgrade */
  authenticate?: (request: unknown) => Promise<{ userId?: string; organizationId?: string } | null>;
  /** Filter events by org from request.scope (default: false) */
  orgScoped?: boolean;
  /** Room/subscription authorization policy */
  roomPolicy?: (
    client: { userId?: string; organizationId?: string },
    room: string,
  ) => boolean | Promise<boolean>;
  /** Max message size from WS clients in bytes (default: 16384) */
  maxMessageBytes?: number;
  /** Max subscriptions per client (default: 100) */
  maxSubscriptionsPerClient?: number;

  /** SSE config. Set false to disable SSE. */
  sse?:
    | false
    | {
        path?: string;
        patterns?: string[];
        heartbeat?: number;
        filter?: (event: DomainEvent<unknown>, request: FastifyRequest) => boolean;
      };

  /** WebSocket config. Set false to disable WebSocket. */
  ws?:
    | false
    | {
        path?: string;
        resources?: string[];
        heartbeatInterval?: number;
        maxClientsPerRoom?: number;
        exposeStats?: boolean | "authenticated";
        onMessage?: (client: WebSocketClient, message: WebSocketMessage) => void | Promise<void>;
        onConnect?: (client: WebSocketClient) => void | Promise<void>;
        onDisconnect?: (client: WebSocketClient) => void | Promise<void>;
      };
}

// ============================================================================
// Plugin
// ============================================================================

const eventGatewayPluginImpl: FastifyPluginAsync<EventGatewayOptions> = async (
  fastify: FastifyInstance,
  opts: EventGatewayOptions = {},
) => {
  const {
    auth = true,
    orgScoped = false,
    roomPolicy,
    maxMessageBytes,
    maxSubscriptionsPerClient,
    authenticate,
  } = opts;

  // Fail-closed: validate auth decorator once for both SSE and WebSocket
  if (auth && !authenticate && !fastify.hasDecorator("authenticate")) {
    throw new Error(
      "[arc-event-gateway] auth is true but fastify.authenticate is not registered. " +
        "Register an auth plugin first, provide a custom authenticate function, or set auth: false.",
    );
  }

  // Register SSE if not disabled
  if (opts.sse !== false) {
    // Lazy import to avoid pulling SSE into bundles when disabled
    const { default: ssePlugin } = await import("../plugins/sse.js");
    await fastify.register(ssePlugin, {
      path: opts.sse?.path ?? "/events/stream",
      requireAuth: auth,
      patterns: opts.sse?.patterns ?? ["*"],
      heartbeat: opts.sse?.heartbeat ?? 30000,
      orgScoped,
      filter: opts.sse?.filter,
    });
  }

  // Register WebSocket if not disabled
  if (opts.ws !== false) {
    // Auto-register @fastify/websocket if not already registered
    if (!fastify.hasDecorator("websocketServer")) {
      try {
        const wsPlugin = await import("@fastify/websocket");
        await fastify.register(wsPlugin.default ?? wsPlugin);
      } catch {
        throw new Error(
          "[arc-event-gateway] WebSocket support requires @fastify/websocket.\n" +
            "Install it: npm install @fastify/websocket\n" +
            "Or disable WebSocket: eventGateway({ ws: false })",
        );
      }
    }
    const { websocketPlugin } = await import("./websocket.js");
    await fastify.register(websocketPlugin, {
      path: opts.ws?.path ?? "/ws",
      auth,
      authenticate,
      resources: opts.ws?.resources ?? [],
      heartbeatInterval: opts.ws?.heartbeatInterval ?? 30000,
      maxClientsPerRoom: opts.ws?.maxClientsPerRoom,
      roomPolicy,
      maxMessageBytes,
      maxSubscriptionsPerClient,
      exposeStats: opts.ws?.exposeStats,
      onMessage: opts.ws?.onMessage,
      onConnect: opts.ws?.onConnect,
      onDisconnect: opts.ws?.onDisconnect,
    });
  }
};

export const eventGatewayPlugin = fp(eventGatewayPluginImpl, {
  name: "arc-event-gateway",
  fastify: "5.x",
}) as FastifyPluginAsync<EventGatewayOptions>;

export default eventGatewayPlugin;
