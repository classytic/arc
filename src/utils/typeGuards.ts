/**
 * Shared Type Guards
 *
 * Reusable type narrowing for Fastify plugin decorators.
 * Eliminates inline `'events' in fastify && ...` checks across the codebase.
 */

import type { FastifyInstance } from "fastify";

export interface EventsDecorator {
  publish: <T>(type: string, payload: T, meta?: Record<string, unknown>) => Promise<void>;
  subscribe: (
    pattern: string,
    handler: (event: {
      type: string;
      payload: unknown;
      meta: Record<string, unknown>;
    }) => Promise<void>,
  ) => Promise<() => void>;
  transportName: string;
}

/** Check if fastify has the events plugin registered */
export function hasEvents(
  instance: FastifyInstance,
): instance is FastifyInstance & { events: EventsDecorator } {
  const inst = instance as unknown as Record<string, unknown>;
  return (
    inst.events != null && typeof (inst.events as Record<string, unknown>).publish === "function"
  );
}
