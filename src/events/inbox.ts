/**
 * Per-handler inbox: run a subscriber at most once per `(handler name, event id)`.
 *
 * A transport redelivers an event to EVERY matching handler; wrapping each one that must not
 * repeat (a ledger post, a stock move) makes a retry re-run only the handler that failed.
 * A failure releases the claim so the redelivery executes afresh; a claim held by another
 * worker fails the delivery (the relay retries it) rather than skipping it.
 */

import {
  fingerprintRequest,
  type IdempotencyClaimStore,
  runIdempotent,
} from "@classytic/repo-core/idempotency";
import type { DomainEvent, EventHandler } from "./EventTransport.js";

export interface InboxOptions {
  /** The claims store — ONE per deployment, shared with command idempotency. */
  readonly store: IdempotencyClaimStore;
  /** Must exceed the handler's worst-case run time. Default: the store's lease default. */
  readonly leaseMs?: number;
}

/** The claim operation every inbox row is filed under. */
export const EVENT_INBOX_OPERATION = "event-inbox";

export function withInbox<T = unknown>(
  name: string,
  handler: EventHandler<T>,
  options: InboxOptions,
): EventHandler<T> {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("[Arc Events] withInbox: a handler name is required — it is the inbox key.");
  }
  return async (event: DomainEvent<T>): Promise<void> => {
    const run = await runIdempotent({
      store: options.store,
      identity: { operation: EVENT_INBOX_OPERATION, key: `${name}:${event.meta.id}` },
      requestFingerprint: fingerprintRequest({ type: event.type, payload: event.payload }),
      ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
      execute: async () => {
        await handler(event);
        return true;
      },
    });
    if (run.outcome === "in_flight") {
      throw new Error(
        `[Arc Events] Handler '${name}' for ${event.type} ${event.meta.id} is in flight elsewhere — retry later.`,
      );
    }
    if (run.outcome === "exhausted") {
      throw new Error(
        `[Arc Events] Handler '${name}' for ${event.type} ${event.meta.id} exhausted its takeovers: ${run.lastError ?? "unknown"}.`,
      );
    }
  };
}
