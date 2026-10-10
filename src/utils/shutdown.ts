/** Stop admissions across every runtime before draining work and disposing domain engines. */

import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";

export interface ShutdownParticipant {
  readonly name: string;
  readonly kind?: "producer" | "consumer";
  stop?(): void | Promise<void>;
  drain?(): void | Promise<void>;
}

interface ShutdownRegistry {
  participants: ShutdownParticipant[];
  completion?: Promise<unknown[]>;
}

const SHUTDOWN = Symbol.for("arc.shutdown");
const admittedWork = new AsyncLocalStorage<{ active: boolean }>();

/** Descendants of admitted work may finish their causal publications during shutdown. */
export async function runAdmittedWork<T>(work: () => T | Promise<T>): Promise<T> {
  if (isAdmittedWork()) return await work();
  const scope = { active: true };
  return admittedWork.run(scope, async () => {
    try {
      return await work();
    } finally {
      scope.active = false;
    }
  });
}

export function isAdmittedWork(): boolean {
  return admittedWork.getStore()?.active === true;
}

/** Seed on the root before plugins register, so encapsulated plugins share one coordinator. */
export function initShutdownRegistry(fastify: FastifyInstance): void {
  const holder = fastify as unknown as Record<symbol, ShutdownRegistry | undefined>;
  if (holder[SHUTDOWN]) return;
  holder[SHUTDOWN] = { participants: [] };
  // Fastify drains HTTP first. Module teardown explicitly joins this coordinator
  // before disposing engines, independently of plugin hook registration order.
  fastify.addHook("onClose", async () => {
    const errors = await runShutdown(fastify);
    for (const err of errors) fastify.log.error({ err }, "[arc] runtime shutdown failed");
  });
}

/** A participant's stop must prevent new work; drain waits for work already admitted. */
export function registerShutdownParticipant(
  fastify: FastifyInstance,
  participant: ShutdownParticipant,
): void {
  initShutdownRegistry(fastify);
  const registry = (fastify as unknown as Record<symbol, ShutdownRegistry>)[SHUTDOWN];
  if (!registry) throw new Error("[arc] shutdown coordinator is unavailable");
  if (registry.completion)
    throw new Error(`[arc] cannot register ${participant.name} during shutdown`);
  registry.participants.push(participant);
}

/** Once-guarded, best effort; callers dispose engines only after this completes. */
export function runShutdown(fastify: FastifyInstance): Promise<unknown[]> {
  const registry = (fastify as unknown as Record<symbol, ShutdownRegistry | undefined>)[SHUTDOWN];
  if (!registry) return Promise.resolve([]);
  registry.completion ??= Promise.resolve().then(async () => {
    const errors: unknown[] = [];
    for (const phase of ["stop", "drain"] as const) {
      const participants =
        phase === "drain"
          ? [
              ...registry.participants.filter((p) => p.kind !== "consumer"),
              ...registry.participants.filter((p) => p.kind === "consumer"),
            ]
          : registry.participants;
      for (const participant of participants) {
        try {
          await participant[phase]?.();
        } catch (cause) {
          errors.push(new Error(`[arc] ${participant.name} shutdown ${phase} failed`, { cause }));
        }
      }
    }
    return errors;
  });
  return registry.completion;
}
