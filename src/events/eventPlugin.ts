/**
 * Event Plugin
 *
 * Integrates event transport with Fastify.
 * Defaults to in-memory transport; configure durable transport for production.
 *
 * @example
 * // Development (in-memory)
 * await fastify.register(eventPlugin);
 *
 * // Production (Redis)
 * await fastify.register(eventPlugin, {
 *   transport: new RedisEventTransport({ url: process.env.REDIS_URL }),
 * });
 */

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  MemoryEventTransport,
  createEvent,
  type EventTransport,
  type DomainEvent,
  type EventHandler,
} from "./EventTransport.js";
import {
  withRetry,
  createDeadLetterPublisher,
  type RetryOptions,
} from "./retry.js";
import { requestContext } from "../context/requestContext.js";

export interface EventPluginOptions {
  /** Event transport (default: MemoryEventTransport) */
  transport?: EventTransport;
  /** Enable event logging (default: false) */
  logEvents?: boolean;
  /**
   * Fail-open mode for runtime resilience (default: true).
   * - true: publish/subscribe/close errors are logged and suppressed
   * - false: errors are thrown to caller
   */
  failOpen?: boolean;
  /**
   * Write-Ahead Log (WAL) configuration for at-least-once delivery guarantees.
   * If provided, events will be saved to the WAL *before* passing to the transport.
   * After a successful publish, they are acknowledged.
   */
  wal?: {
    save: (event: DomainEvent) => Promise<void>;
    acknowledge?: (eventId: string) => Promise<void>;
  };
  /**
   * Auto-wrap all subscribed handlers with retry logic.
   * When enabled, failed handler invocations are retried with exponential backoff.
   */
  retry?: Pick<
    RetryOptions,
    "maxRetries" | "backoffMs" | "maxBackoffMs" | "jitter"
  >;
  /**
   * Dead letter queue for events that exhaust all retries.
   * Requires `retry` to be enabled. If `retry` is set but no custom `store`,
   * failed events are published to the `$deadLetter` event type by default.
   */
  deadLetterQueue?: {
    /** Custom store function. If omitted, publishes to '$deadLetter' event type. */
    store?: (event: DomainEvent, errors: Error[]) => void | Promise<void>;
  };
  /** Callback after successful publish (for metrics/tracking) */
  onPublish?: (event: DomainEvent) => void;
  /** Callback on publish failure (for metrics/alerting) */
  onPublishError?: (event: DomainEvent, error: Error) => void;
}

declare module "fastify" {
  interface FastifyInstance {
    events: {
      /** Publish an event */
      publish: <T>(
        type: string,
        payload: T,
        meta?: Partial<DomainEvent["meta"]>,
      ) => Promise<void>;
      /** Subscribe to events */
      subscribe: (
        pattern: string,
        handler: EventHandler,
      ) => Promise<() => void>;
      /** Get transport name */
      transportName: string;
    };
  }
}

const eventPlugin: FastifyPluginAsync<EventPluginOptions> = async (
  fastify: FastifyInstance,
  opts: EventPluginOptions = {},
) => {
  const {
    transport = new MemoryEventTransport(),
    logEvents = false,
    failOpen = true,
    retry: retryOpts,
    deadLetterQueue: dlqOpts,
    wal,
    onPublish,
    onPublishError,
  } = opts;

  // Decorate fastify with event utilities
  fastify.decorate("events", {
    publish: async <T>(
      type: string,
      payload: T,
      meta?: Partial<DomainEvent["meta"]>,
    ): Promise<void> => {
      // Auto-inject correlationId from request context if not already set
      const store = requestContext.get();
      const enrichedMeta: Partial<DomainEvent["meta"]> = {
        ...(store?.requestId && !meta?.correlationId
          ? { correlationId: store.requestId }
          : {}),
        ...meta,
      };
      const event = createEvent(type, payload, enrichedMeta);

      if (logEvents) {
        fastify.log?.info?.(
          {
            eventType: type,
            eventId: event.meta.id,
            correlationId: event.meta.correlationId,
          },
          "Publishing event",
        );
      }

      try {
        if (wal) {
          await wal.save(event);
        }
        await transport.publish(event);
        if (wal?.acknowledge) {
          await wal.acknowledge(event.meta.id);
        }
        onPublish?.(event);
      } catch (error) {
        fastify.log?.error?.(
          { transport: transport.name, eventType: type, error },
          "[Arc Events] Failed to publish event",
        );
        onPublishError?.(event, error as Error);
        if (!failOpen) throw error;
      }
    },

    subscribe: async (
      pattern: string,
      handler: EventHandler,
    ): Promise<() => void> => {
      // Auto-wrap handler with retry if configured (skip for DLQ subscriptions)
      let wrappedHandler = handler;
      if (retryOpts && pattern !== "$deadLetter") {
        wrappedHandler = withRetry(handler, {
          ...retryOpts,
          onDead: dlqOpts?.store ?? createDeadLetterPublisher(fastify.events),
          logger: fastify.log as import("./EventTransport.js").EventLogger,
        });
      }

      if (logEvents) {
        fastify.log?.info?.(
          { pattern, retry: !!retryOpts },
          "Subscribing to events",
        );
      }
      try {
        return await transport.subscribe(pattern, wrappedHandler);
      } catch (error) {
        fastify.log?.error?.(
          { transport: transport.name, pattern, error },
          "[Arc Events] Failed to subscribe to events",
        );
        if (!failOpen) throw error;
        return () => {};
      }
    },

    transportName: transport.name,
  });

  // Cleanup on close
  fastify.addHook("onClose", async () => {
    try {
      await transport.close?.();
    } catch (error) {
      fastify.log?.warn?.(
        { transport: transport.name, error },
        "[Arc Events] Transport close failed",
      );
      if (!failOpen) throw error;
    }
  });

  // Log transport type
  if (transport.name === "memory") {
    fastify.log?.warn?.(
      "[Arc Events] Using in-memory transport. Events will not persist or scale across instances. " +
        "For production, configure a durable transport (Redis, RabbitMQ, etc.)",
    );
  } else {
    fastify.log?.debug?.(`[Arc Events] Using ${transport.name} transport`);
  }
};

export default fp(eventPlugin, {
  name: "arc-events",
  fastify: "5.x",
});

export { eventPlugin };
