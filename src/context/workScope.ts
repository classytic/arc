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
 *
 * The inherit rule is right for work the caller OWNS — a publish it made, on
 * its own data, awaited in its own stack. It is wrong for work merely TRIGGERED
 * from a request: a background pass that also processes other callers' items
 * would inherit one request's tenant, user and cache for all of them.
 * AsyncLocalStorage propagates through `setImmediate`/`setTimeout`/promises, so
 * deferring is not enough to escape — whoever hands work to a shared processor
 * must leave the scope explicitly (`requestContext.storage.exit(fn)`, as
 * `OutboxModuleExports.requestDrain` does) so each item opens its own.
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
  const slots = store as unknown as Record<symbol, T>;
  // PRESENCE, not truthiness: a `create()` that legitimately returns
  // `undefined` (or `null`, or `0`) must still be a memo HIT. Testing the value
  // would re-run the factory on every call for exactly those slots — which
  // silently turns "created once per scope", the one guarantee this has, into
  // "created per call" for the caller least likely to check.
  if (Object.hasOwn(slots, slot)) return slots[slot];
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
