/**
 * Event bridge — wires arc's event bus to WebSocket room broadcasts, and
 * registers the optional stats endpoint.
 *
 * Split out of the plugin orchestrator because both concerns share the
 * "stand up a side-channel once, tear down on close" shape and would bloat
 * the main plugin otherwise.
 */

import type { FastifyInstance } from "fastify";
import type { RoomManager } from "./room-manager.js";
import type { WebSocketPluginOptions } from "./types.js";

interface ArcEventShape {
  payload?: unknown;
  meta?: {
    timestamp?: unknown;
    userId?: unknown;
    organizationId?: string;
  };
}

type EventsSubscribeFn = (
  type: string,
  handler: (event: ArcEventShape) => Promise<void> | void,
) => Promise<() => void> | (() => void);

/**
 * Subscribe to `<resource>.created|updated|deleted` events for every
 * resource in `resources` and fan them out to the matching room (same
 * name as the resource). Returns the unsubscriber list so the caller can
 * clean up on `onClose`.
 *
 * Org-scoped events (events carrying `meta.organizationId`) broadcast
 * only to clients in that org; unscoped events broadcast to every
 * subscriber of the room.
 */
export async function wireResourceEvents(
  fastify: FastifyInstance,
  rooms: RoomManager,
  resources: readonly string[],
): Promise<Array<() => void>> {
  const unsubscribers: Array<() => void> = [];

  const events = (
    fastify as FastifyInstance & {
      events?: { subscribe?: EventsSubscribeFn };
    }
  ).events;
  if (!events?.subscribe) return unsubscribers;
  if (resources.length === 0) return unsubscribers;

  const subscribe = events.subscribe;
  for (const resourceName of resources) {
    for (const op of ["created", "updated", "deleted"] as const) {
      const unsub = await subscribe(`${resourceName}.${op}`, (event) => {
        const room = resourceName;
        const payload = JSON.stringify({
          type: `${resourceName}.${op}`,
          data: event.payload,
          meta: {
            timestamp: event.meta?.timestamp,
            userId: event.meta?.userId,
            organizationId: event.meta?.organizationId,
          },
        });

        // Adapter-aware broadcast — delivers locally AND to other instances.
        // Org-scoped events only reach clients in the same org.
        if (event.meta?.organizationId) {
          void rooms.broadcastToOrgWithAdapter(event.meta.organizationId, room, payload);
        } else {
          void rooms.broadcastWithAdapter(room, payload);
        }
      });
      unsubscribers.push(unsub);
    }
  }
  return unsubscribers;
}

/**
 * Register the optional `{path}/stats` endpoint.
 *
 *   - `false` (default): no registration
 *   - `true`: open endpoint
 *   - `'authenticated'`: guarded by `fastify.authenticate` if registered;
 *     silently skipped with a warn when it isn't (doesn't fail boot — the
 *     stats endpoint is diagnostic, not load-bearing)
 */
export function registerStatsRoute(
  fastify: FastifyInstance,
  rooms: RoomManager,
  path: string,
  expose: WebSocketPluginOptions["exposeStats"],
): void {
  if (expose === true) {
    fastify.get(`${path}/stats`, async () => ({ success: true, data: rooms.getStats() }));
    return;
  }
  if (expose === "authenticated") {
    if (fastify.hasDecorator("authenticate")) {
      // Cast narrows to the preHandler shape arc's auth plugin actually
      // exposes. Fastify's decorator types don't preserve this, so a
      // local cast is the cleanest reachable bridge.
      const authenticate = (
        fastify as FastifyInstance & {
          authenticate: import("fastify").preHandlerHookHandler;
        }
      ).authenticate;
      fastify.get(
        `${path}/stats`,
        { preHandler: authenticate } as import("fastify").RouteShorthandOptions,
        async () => ({ success: true, data: rooms.getStats() }),
      );
    } else {
      fastify.log.warn(
        'arc-websocket: exposeStats is "authenticated" but fastify.authenticate is not registered — stats endpoint skipped',
      );
    }
  }
}
