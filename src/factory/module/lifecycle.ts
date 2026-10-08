/**
 * Module event-handler lifecycle — subscription in dependency order with
 * rollback-on-failure, and best-effort reverse-order teardown.
 */

import type { FastifyInstance } from "fastify";
import type { EventHandler } from "../../events/EventTransport.js";
import { wrapWithAttribution, wrapWithBoundary } from "../../events/subscribe-helpers.js";
import { resolveModuleArm } from "./resolve.js";
import type { ArcModule, EventHandlerDefinition } from "./types.js";

/** Minimal view of the event bus the handlers arm needs (arc's `fastify.events`). */
interface EventBusLike {
  subscribe(pattern: string, handler: EventHandler): Promise<() => void> | (() => void);
}

/**
 * Subscribe every module's `eventHandlers` in dependency order (pass the
 * `orderModules`-sorted list). Returns the ordered list of unsubscribe
 * functions so the caller can tear them down at shutdown BEFORE module
 * `onClose` (while module deps are still alive). Fails at boot on:
 *   - a duplicate NAMED handler across modules (attributing both owners);
 *   - a module declaring handlers while the event subsystem is unavailable.
 * Resolves factory contributions (after bootstraps) so a handler can close over
 * booted engines rather than a global getter.
 */
export async function subscribeModuleEventHandlers(
  fastify: FastifyInstance,
  modules: readonly ArcModule[],
  /** Per-module handler counts, so descriptors never re-resolve the factories. */
  countsByModule?: Map<string, number>,
  consumedByModule?: Map<string, string[]>,
): Promise<Array<() => void | Promise<void>>> {
  const unsubscribes: Array<() => void | Promise<void>> = [];
  const owner = new Map<string, string>();
  try {
    for (const m of modules) {
      const handlers = await resolveModuleArm(m, "eventHandlers", m.eventHandlers, fastify);
      countsByModule?.set(m.name, handlers.length);
      if (handlers.length === 0) continue;
      const bus = (fastify as { events?: EventBusLike }).events;
      if (!bus) {
        throw new Error(
          `[arc] module "${m.name}" declares eventHandlers but the event subsystem is unavailable (fastify.events). Enable arcPlugins.events.`,
        );
      }
      for (const [index, def] of handlers.entries()) {
        if (def.name !== undefined) {
          const prior = owner.get(def.name);
          if (prior !== undefined) {
            throw new Error(
              `[arc] duplicate event-handler name "${def.name}" — declared by module "${prior}" and module "${m.name}". Named event handlers must be unique across the module graph; prefix names with the owning module.`,
            );
          }
          owner.set(def.name, m.name);
        }
        const patterns = Array.isArray(def.event) ? def.event : [def.event as string];
        const handler = applyBoundary(
          def,
          m.name,
          handlerLabel(def, m.name, patterns, index),
          fastify,
        );
        consumedByModule?.set(m.name, [...(consumedByModule.get(m.name) ?? []), ...patterns]);
        for (const pattern of patterns) {
          unsubscribes.push(await bus.subscribe(pattern, handler));
        }
      }
    }
    return unsubscribes;
  } catch (err) {
    const rollbackErrors = await unsubscribeModuleEventHandlers(unsubscribes);
    for (const rollbackError of rollbackErrors) {
      fastify.log.error(
        { err: rollbackError },
        "[arc] module event-handler activation rollback failed",
      );
    }
    throw err;
  }
}

/**
 * The name a subscriber's errors and logs carry: its declared `name`, else
 * `<module>:<patterns>#<index in the module's handlers>` — unique, so two unnamed
 * subscribers of one event stay distinguishable in a dead-lettered row.
 */
function handlerLabel(
  def: EventHandlerDefinition,
  moduleName: string,
  patterns: readonly string[],
  index: number,
): string {
  return def.name ?? `${moduleName}:${patterns.join(",")}#${index}`;
}

/**
 * Without a boundary, attribute the handler's errors to `label` and let them reach the transport —
 * that is what makes the durable path work (unacked → redelivered → DLQ), and the label is what
 * names the subscriber in the outbox's `lastError`. With the opt-in boundary, failures are logged
 * under the handler's name (`<module>.<pattern>` when unnamed) and swallowed, so the original error
 * reaches the boundary's `onError` untouched.
 */
function applyBoundary(
  def: EventHandlerDefinition,
  moduleName: string,
  label: string,
  fastify: FastifyInstance,
): EventHandler {
  if (!def.boundary) return wrapWithAttribution(def.handler, label);
  const onError = typeof def.boundary === "object" ? def.boundary.onError : undefined;
  return wrapWithBoundary(def.handler, {
    logger: fastify.log,
    name: def.name ?? `${moduleName}.${String(def.event)}`,
    ...(onError ? { onError } : {}),
  });
}

/** Best-effort reverse-order teardown; every unsubscribe is attempted. */
export async function unsubscribeModuleEventHandlers(
  unsubscribes: readonly (() => void | Promise<void>)[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (let index = unsubscribes.length - 1; index >= 0; index--) {
    try {
      await unsubscribes[index]?.();
    } catch (err) {
      errors.push(err);
    }
  }
  return errors;
}
