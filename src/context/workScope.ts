/**
 * One ambient scope per UNIT OF WORK — an HTTP request, a delivered event, a
 * scheduled job run — entered by whoever owns the lifecycle.
 *
 * `requestScopedCache()`, correlation-id injection and trace headers all key on
 * `requestContext`. Only arc's HTTP hook ever entered it, so every one of them
 * was inert on an outbox relay tick, a broker delivery and a job run — the
 * places a fan-out moves to. `runWorkScope` is the same store, entered from
 * those places too.
 *
 * Rules:
 *   - INHERIT if a scope is active. A dispatch inside a request shares the
 *     request's store; shadowing it would discard the reads the request made.
 *   - `scopedValue` returns `undefined` outside a scope. Never a process-wide
 *     fallback — that is the cross-scope leak the scoping exists to prevent.
 */

import type { DomainEvent } from "@classytic/primitives/events";
import { type RequestStore, requestContext, type WorkKind } from "./requestContext.js";

export type { WorkKind } from "./requestContext.js";

export interface WorkSeed {
  readonly kind: WorkKind;
  /** Becomes `requestId` — the correlation key for anything published inside. */
  readonly id: string;
  readonly organizationId?: string;
}

/** Enter a scope for `fn`, or run it inside the active one. */
export function runWorkScope<T>(seed: WorkSeed, fn: () => T): T {
  if (requestContext.get()) return fn();
  const store: RequestStore = {
    kind: seed.kind,
    requestId: seed.id,
    startTime: performance.now(),
    ...(seed.organizationId !== undefined ? { organizationId: seed.organizationId } : {}),
  };
  return requestContext.run(store, fn);
}

/**
 * A per-scope memo slot: created once on first use, the same instance after.
 * `undefined` outside a scope.
 */
export function scopedValue<T>(slot: symbol, create: () => T): T | undefined {
  const store = requestContext.get();
  if (!store) return undefined;
  const slots = store as unknown as Record<symbol, T | undefined>;
  const existing = slots[slot];
  if (existing !== undefined) return existing;
  const created = create();
  slots[slot] = created;
  return created;
}

/**
 * The scope an event dispatch runs in. The correlation id is the scope id so a
 * child event published from a handler chains to the same correlation; the
 * tenant rides `meta`, never the payload.
 */
export function workSeedFromEvent(event: DomainEvent): WorkSeed {
  return {
    kind: "event",
    id: event.meta.correlationId ?? event.meta.id,
    ...(event.meta.organizationId !== undefined
      ? { organizationId: event.meta.organizationId }
      : {}),
  };
}
