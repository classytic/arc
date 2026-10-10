/**
 * Per-handler completion deduplication. Without a shared transaction, a crash between an
 * effect and completion can repeat the effect: handlers must dedupe effects by event id.
 * With `transaction`, the handler's DB effect and claim completion share one session; the
 * host must provide a transaction-aware claim store on the SAME database connection.
 */

import {
  fingerprintRequest,
  type IdempotencyClaimStore,
  runIdempotent,
} from "@classytic/repo-core/idempotency";
import type { DomainEvent, EventHandler } from "./EventTransport.js";
import { withSubscriberId } from "./subscriberIdentity.js";

export interface InboxOptions {
  /** The claims store — ONE per deployment, shared with command idempotency. */
  readonly store: IdempotencyClaimStore;
  /** Must exceed the handler's worst-case run time. Default: the store's lease default. */
  readonly leaseMs?: number;
  /** Commit or roll back ALL work, including claim completion; external effects need their own key. */
  readonly transaction?: <T>(work: (session: unknown) => Promise<T>) => Promise<T>;
}

export interface InboxHandlerContext {
  /** Use this session on every database write when a transaction is configured. */
  readonly session?: unknown;
  /** Stable effect deduplication key for external calls or nontransactional handlers. */
  readonly eventId: string;
}

export type InboxHandler<T> = (
  event: DomainEvent<T>,
  context: InboxHandlerContext,
) => Promise<void>;

/** The claim operation every inbox row is filed under. */
export const EVENT_INBOX_OPERATION = "event-inbox";

export function withInbox<T = unknown>(
  name: string,
  handler: InboxHandler<T>,
  options: InboxOptions,
): EventHandler<T> {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("[Arc Events] withInbox: a handler name is required — it is the inbox key.");
  }
  return withSubscriberId(name, async (event: DomainEvent<T>): Promise<void> => {
    const execute = async (session?: unknown) => {
      const run = await runIdempotent({
        store: options.store,
        identity: { operation: EVENT_INBOX_OPERATION, key: `${name}:${event.meta.id}` },
        requestFingerprint: fingerprintRequest({ type: event.type, payload: event.payload }),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        ...(session !== undefined ? { storeOptions: { session } } : {}),
        execute: async () => {
          await handler(event, { session, eventId: event.meta.id });
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
    if (options.transaction)
      await options.transaction(async (session) => {
        if (session === undefined || session === null)
          throw new Error("[Arc Events] Inbox transaction must provide a database session.");
        await execute(session);
      });
    else await execute();
  });
}
