/**
 * Event Outbox — Transactional Event Delivery
 *
 * Implements the transactional outbox pattern:
 * 1. Business operation writes event to outbox store (same DB transaction)
 * 2. Relay process reads pending events and publishes to transport
 * 3. Only marks as delivered after successful publish
 *
 * This guarantees at-least-once delivery even if the transport is down.
 *
 * @example Basic
 * ```typescript
 * import { EventOutbox, MemoryOutboxStore } from '@classytic/arc/events';
 *
 * const outbox = new EventOutbox({
 *   store: new MemoryOutboxStore(),
 *   transport: redisTransport,
 * });
 *
 * await outbox.store({ type: 'order.created', payload: order, meta: { id, timestamp } });
 * await outbox.relay(); // publishes pending events to transport
 * ```
 *
 * @example Transactional write (host-owned store)
 * ```typescript
 * await db.withTransaction(async (session) => {
 *   await orders.insertOne(order, { session });
 *   await outbox.store(event, { session }); // same DB commit
 * });
 * ```
 *
 * @example Multi-worker relay with claim/lease
 * ```typescript
 * // Worker A and Worker B both call relay() — lease prevents double-publish
 * const outbox = new EventOutbox({
 *   store,
 *   transport,
 *   consumerId: `worker-${process.pid}`,
 *   leaseMs: 30_000,
 * });
 * ```
 */

import type { RepositoryLike } from "../adapters/interface.js";
import type { DeadLetteredEvent, DomainEvent, EventTransport } from "./EventTransport.js";
import { MemoryOutboxStore } from "./memory-outbox.js";
import { repositoryAsOutboxStore } from "./repository-outbox-adapter.js";

// Re-export MemoryOutboxStore from the same barrel so existing
// `import { MemoryOutboxStore } from '@classytic/arc/events'` keeps working.
export { MemoryOutboxStore };

/** Default outbox retention — delivered events older than this are eligible for purge */
const DEFAULT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_LEASE_MS = 30_000;

/**
 * **Terminology (v2.8.1+):**
 *
 * Arc's outbox uses **`delivered`** as the canonical term for "event has been
 * successfully published to the transport and marked by `acknowledge()`".
 *
 * - **`acknowledge()`** is the operation that transitions an event to delivered
 * - **`delivered`** is the resulting state
 * - **`deliveredAt`** is the timestamp column/field in every reference implementation
 *
 * Store authors should use `deliveredAt` for their timestamp field. Older
 * drafts of these docs used `acknowledgedAt` — that is a deprecated alias and
 * should not be used in new code.
 */

// ============================================================================
// Option Types (all backward-compatible additions)
// ============================================================================

/**
 * Options passed to {@link OutboxStore.save} for richer write semantics.
 * Stores may ignore fields they don't support — contract is best-effort.
 */
export interface OutboxWriteOptions {
  /**
   * Host-provided DB session/transaction handle for atomic writes.
   * Typed as `unknown` so stores can accept any backend (mongoose session,
   * pg client, Prisma tx, etc.) without Arc taking a peer dep.
   */
  readonly session?: unknown;
  /** Earliest time the event should be visible to relay workers (for delayed publishing) */
  readonly visibleAt?: Date;
  /** Idempotency key — stores that support it should dedupe on this */
  readonly dedupeKey?: string;
  /** Partition/routing key for sharded transports (Kafka, Redis Streams) */
  readonly partitionKey?: string;
  /** Arbitrary headers propagated to the transport layer */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Options for {@link OutboxStore.claimPending} — lease-based work claim.
 * Supports safe multi-worker relay: each worker atomically claims a batch
 * with a lease TTL, preventing duplicate publishes.
 */
export interface OutboxClaimOptions {
  /** Max events to claim (default: batchSize) */
  readonly limit?: number;
  /** Unique identifier for the claiming worker */
  readonly consumerId?: string;
  /** Lease duration in ms — claim is released automatically after this */
  readonly leaseMs?: number;
  /** Only claim events of these types (optional filter) */
  readonly types?: readonly string[];
}

/** Options for {@link OutboxStore.acknowledge} */
export interface OutboxAcknowledgeOptions {
  /** Worker identifier — stores may enforce "only owner can ack" */
  readonly consumerId?: string;
}

/** Options for {@link OutboxStore.fail} */
export interface OutboxFailOptions {
  /** Worker identifier — stores may enforce "only owner can fail" */
  readonly consumerId?: string;
  /** Schedule retry for a later time (implements backoff) */
  readonly retryAt?: Date;
  /** Move the event to dead-letter state (no further retries) */
  readonly deadLetter?: boolean;
}

/** Normalized error info passed to {@link OutboxStore.fail} */
export interface OutboxErrorInfo {
  readonly message: string;
  readonly code?: string;
}

/**
 * Context passed to {@link OutboxFailurePolicy}.
 */
export interface OutboxFailureContext {
  /** The event whose delivery just failed */
  readonly event: DomainEvent;
  /** The error returned by the transport / handler */
  readonly error: Error;
  /**
   * Attempt count including this failure (1 on the first fail).
   *
   * Tracked by {@link EventOutbox} in-process — accurate within a single
   * relay process, resets on restart. For durable attempt counts, query
   * your store directly inside the policy.
   */
  readonly attempts: number;
}

/**
 * Decision returned by {@link OutboxFailurePolicy} — controls how the
 * relay calls `store.fail()` for a failed event.
 */
export interface OutboxFailureDecision {
  /** Schedule retry for this time. Omit for immediate (next-poll) retry. */
  readonly retryAt?: Date;
  /**
   * Move the event to dead-letter state (no further retries). When `true`,
   * {@link RelayResult.deadLettered} is incremented.
   */
  readonly deadLetter?: boolean;
}

/**
 * Centralised retry/DLQ policy evaluated by {@link EventOutbox.relayBatch}
 * on every failure. Returns the options passed to `store.fail()`.
 *
 * Typical shape:
 * ```typescript
 * failurePolicy: ({ attempts, error }) => {
 *   if (attempts >= 5) return { deadLetter: true };
 *   return { retryAt: exponentialBackoff({ attempt: attempts }) };
 * }
 * ```
 *
 * Without a policy, the relay uses the legacy "immediate re-visibility" fail
 * behaviour (each fail() is equivalent to `{}`).
 */
export type OutboxFailurePolicy = (
  ctx: OutboxFailureContext,
) => OutboxFailureDecision | Promise<OutboxFailureDecision>;

/**
 * Thrown by a store when `acknowledge` / `fail` is called by a consumer that
 * does not own the event's current lease.
 *
 * Stores that enforce lease ownership MUST throw this (not silently return)
 * so {@link EventOutbox} can detect the mismatch and avoid over-counting
 * successful deliveries. {@link EventOutbox.relay} catches it and reports
 * via {@link EventOutboxOptions.onError} instead of counting as relayed.
 */
export class OutboxOwnershipError extends Error {
  readonly eventId: string;
  readonly attemptedBy: string;
  readonly currentOwner: string | null;

  constructor(eventId: string, attemptedBy: string, currentOwner: string | null) {
    super(
      `Outbox ownership mismatch for event "${eventId}": attempted by "${attemptedBy}", current owner is "${currentOwner ?? "none"}". ` +
        `The lease may have expired and been reclaimed by another worker.`,
    );
    this.name = "OutboxOwnershipError";
    this.eventId = eventId;
    this.attemptedBy = attemptedBy;
    this.currentOwner = currentOwner;
  }
}

/** Thrown by {@link EventOutbox.store} when an event is missing `type` or `meta.id`. */
export class InvalidOutboxEventError extends Error {
  constructor(reason: string) {
    super(`Invalid outbox event: ${reason}`);
    this.name = "InvalidOutboxEventError";
  }
}

// ============================================================================
// Outbox Store Interface
// ============================================================================

/**
 * Durable storage contract for the transactional outbox pattern.
 *
 * **Required methods**: `save`, `getPending`, `acknowledge`.
 *
 * **Optional capabilities** — stores opt-in to richer semantics:
 * - `claimPending` — lease-based work claim for multi-worker relay
 * - `fail` — failure tracking with retry scheduling and dead-letter
 * - `purge` — acknowledged event cleanup
 *
 * Arc's {@link EventOutbox} detects capabilities at runtime and degrades
 * gracefully for legacy stores that only implement the required methods.
 *
 * ## Required semantics
 *
 * Implementations MUST honor these contracts — `EventOutbox` depends on them
 * for correctness of at-least-once delivery:
 *
 * 1. **`save` must reject invalid events.** If `event.type` or `event.meta.id`
 *    is missing/empty, throw — do not persist. `EventOutbox.store()` validates
 *    first, but stores should defend against direct-save code paths.
 *
 * 2. **`claimPending` must be atomic.** Two workers calling `claimPending`
 *    concurrently must never receive the same event. Stores backed by SQL/Mongo
 *    should use `SELECT ... FOR UPDATE SKIP LOCKED` or `findOneAndUpdate` with
 *    `{ leaseOwner: null }` as the match condition.
 *
 * 3. **`acknowledge` / `fail` must throw {@link OutboxOwnershipError} on
 *    ownership mismatch.** When `options.consumerId` is provided and does not
 *    match the current lease owner, the method MUST throw — never silently
 *    no-op. `EventOutbox.relay` relies on this signal to avoid counting
 *    hijacked events as successfully relayed.
 *
 * 4. **`acknowledge` on an unknown `eventId` is a no-op.** This keeps relay
 *    idempotent when the store has been purged or the event was manually
 *    removed. Do NOT throw `OutboxOwnershipError` in this case.
 *
 * 5. **`fail` must deterministically update lease/visibility.** On success,
 *    the event MUST become re-claimable (either immediately or at `retryAt`),
 *    or transition to dead-letter state. The lease owner should be cleared.
 *
 * 6. **Malformed events must never be returned by `getPending`/`claimPending`.**
 *    If the store's underlying storage has corrupt rows, the store is
 *    responsible for quarantining them (e.g., direct DB delete, DLQ).
 */
export interface OutboxStore {
  /**
   * Save event to outbox (typically called within a business transaction).
   *
   * MUST reject events missing `type` or `meta.id` — throw rather than persist.
   *
   * @param event - Event to persist
   * @param options - Optional write metadata (session, visibleAt, dedupeKey, etc.)
   */
  save(event: DomainEvent, options?: OutboxWriteOptions): Promise<void>;

  /**
   * Get pending (unrelayed) events, ordered FIFO.
   *
   * This is the legacy/simple pull API. Multi-worker deployments should
   * prefer {@link OutboxStore.claimPending} to avoid duplicate publishes.
   *
   * Events returned by this method MUST be well-formed (valid `type` and
   * `meta.id`). Corrupt rows must be quarantined by the store, not exposed
   * to the relay loop.
   */
  getPending(limit: number): Promise<DomainEvent[]>;

  /**
   * Atomically claim pending events with a lease.
   *
   * When implemented, {@link EventOutbox.relay} prefers this over `getPending`
   * so multi-worker relay is safe: each worker holds an exclusive lease on
   * its batch, and stale leases are automatically recovered.
   *
   * **Atomicity is mandatory**: two concurrent callers must never receive
   * overlapping events. Use `SELECT ... FOR UPDATE SKIP LOCKED` (SQL) or
   * a compound condition on `findOneAndUpdate` (Mongo).
   */
  claimPending?(options?: OutboxClaimOptions): Promise<DomainEvent[]>;

  /**
   * Mark event as successfully relayed.
   *
   * **Ownership contract**: If `options.consumerId` is provided and does not
   * match the current lease owner, this method MUST throw
   * {@link OutboxOwnershipError}. Unknown `eventId` is a no-op.
   *
   * @param eventId - Event ID (from `meta.id`)
   * @param options - Optional ack metadata (consumerId for lease enforcement)
   * @throws {@link OutboxOwnershipError} on ownership mismatch
   */
  acknowledge(eventId: string, options?: OutboxAcknowledgeOptions): Promise<void>;

  /**
   * Record a relay failure. When implemented, {@link EventOutbox.relay} calls
   * this instead of stopping the batch — enables retry scheduling and DLQ.
   *
   * **Ownership contract**: Same as `acknowledge` — MUST throw
   * {@link OutboxOwnershipError} on mismatch. After a successful call, the
   * lease owner MUST be cleared and the event MUST be re-claimable (at
   * `retryAt` if provided) or transitioned to dead-letter.
   *
   * @throws {@link OutboxOwnershipError} on ownership mismatch
   */
  fail?(eventId: string, error: OutboxErrorInfo, options?: OutboxFailOptions): Promise<void>;

  /**
   * Return events currently in dead-letter state as typed
   * {@link DeadLetteredEvent} envelopes.
   *
   * Closes the loop between {@link OutboxStore.fail} (with `deadLetter: true`)
   * and {@link import('./EventTransport.js').DeadLetteredEvent} — apps get the
   * same shape out of the outbox that {@link import('./retry.js').withRetry}
   * delivers to transports. No hand-building DLQ envelopes.
   *
   * Implementations MUST populate `error`, `attempts`, and both
   * `firstFailedAt` / `lastFailedAt` from whatever they tracked during `fail()`
   * calls. `handlerName` is optional — stores that don't track it can omit.
   *
   * @param limit - Max envelopes to return
   */
  getDeadLettered?(limit: number): Promise<DeadLetteredEvent[]>;

  /**
   * Purge old **delivered** events (optional, DB-agnostic contract).
   *
   * Cleanup is scoped to events in the `delivered` state — events still
   * pending, failed, or dead-lettered MUST NOT be removed by purge.
   *
   * Arc does **not** ship a concrete implementation — your store owns the
   * cleanup strategy that fits your database:
   *
   * - **MongoDB:** TTL index on `deliveredAt` (automatic, zero-code)
   * - **SQL:** Scheduled `DELETE FROM outbox WHERE status = 'delivered' AND delivered_at < :cutoff`
   * - **Redis:** Key expiry (`EXPIRE`) on delivered entries
   *
   * Called by {@link EventOutbox.purge}. If not implemented, cleanup is
   * entirely the app's responsibility via native DB tools.
   *
   * @param olderThanMs - Remove events delivered more than this many ms ago
   * @returns Number of purged events
   */
  purge?(olderThanMs: number): Promise<number>;
}

// ============================================================================
// EventOutbox
// ============================================================================

/** Reason codes passed to {@link EventOutboxOptions.onError}. */
export type OutboxRelayErrorKind =
  | "publish_failed"
  | "acknowledge_failed"
  | "fail_failed"
  | "ownership_mismatch"
  | "malformed_event";

/**
 * Rich per-batch outcome returned by {@link EventOutbox.relayBatch}.
 *
 * Useful for operational dashboards, alerting thresholds, and test assertions.
 * The simpler {@link EventOutbox.relay} returns just the `relayed` count for
 * backward compatibility.
 */
export interface RelayResult {
  /** Number of events successfully published AND acknowledged */
  readonly relayed: number;
  /** Number of events claimed and attempted in this batch */
  readonly attempted: number;
  /** Number of publish failures (transport rejected the event) */
  readonly publishFailed: number;
  /** Number of acknowledge failures after successful publish (at-least-once replay risk) */
  readonly ackFailed: number;
  /** Number of ownership mismatches (our lease expired mid-flight) */
  readonly ownershipMismatches: number;
  /** Number of malformed events encountered (aborts the batch) */
  readonly malformed: number;
  /** Number of fail() calls that themselves threw (store bugs / contention) */
  readonly failHookErrors: number;
  /**
   * Number of events moved to dead-letter state this batch via the configured
   * {@link OutboxFailurePolicy}. Zero when no policy is set or no failure
   * tripped the `deadLetter` branch.
   */
  readonly deadLettered: number;
  /** Whether `publishMany` was used (true) or per-event `publish` (false) */
  readonly usedPublishMany: boolean;
}

/**
 * Called by {@link EventOutbox.relay} when a non-fatal error occurs during
 * a batch. Used for logging and metrics. Must not throw.
 */
export type OutboxRelayErrorHandler = (info: {
  readonly kind: OutboxRelayErrorKind;
  readonly event?: DomainEvent;
  readonly error: Error;
}) => void;

export interface EventOutboxOptions {
  /**
   * Repository managing the outbox collection. Arc consumes it directly —
   * no wrapper classes. Requires `create`, `getOne`, `findAll`,
   * `deleteMany`, and `findOneAndUpdate` from `RepositoryLike` (mongokit
   * ≥3.8 satisfies all of these). Takes precedence over `store` when both
   * are passed.
   *
   * Use this for the common path where the outbox lives in your primary
   * database. Use `store` for non-repository backends (memory / custom).
   */
  readonly repository?: RepositoryLike;
  /**
   * Non-repository outbox store. Use when your backend isn't a repository
   * (memory for tests, Kafka, DynamoDB, custom). Ignored if `repository`
   * is also passed.
   */
  readonly store?: OutboxStore;
  /** Transport to relay events to (optional — can relay later) */
  readonly transport?: EventTransport;
  /** Max events per relay batch (default: 100) */
  readonly batchSize?: number;
  /**
   * Unique identifier for this relay worker. Used when the store supports
   * `claimPending`/`fail` to enforce lease ownership. Defaults to a random ID.
   */
  readonly consumerId?: string;
  /**
   * Lease duration in ms for claimed events. Only used when the store
   * supports `claimPending`. Default: 30 seconds.
   */
  readonly leaseMs?: number;
  /**
   * Callback for non-fatal errors during relay: publish failures,
   * ownership mismatches, ack/fail errors, malformed events. Use this for
   * logging and metrics. Must not throw — exceptions are swallowed.
   */
  readonly onError?: OutboxRelayErrorHandler;
  /**
   * Enable {@link EventTransport.publishMany} when the transport implements it.
   * Default: `true`. Set to `false` to force per-event `publish()` — useful
   * for transports where strict event-order observability matters more than
   * throughput, or to debug batch-specific issues.
   */
  readonly usePublishMany?: boolean;
  /**
   * Retry/DLQ decision policy. When set, {@link EventOutbox.relayBatch}
   * invokes this on every failure and uses the returned options for
   * `store.fail()`. Centralises the "after N fails, dead-letter" rule so
   * apps don't recompute `exponentialBackoff` + escalation thresholds on
   * every failure site.
   *
   * Without a policy, `fail()` is called with `{}` (immediate re-visibility
   * on next poll) — legacy behaviour, unchanged.
   */
  readonly failurePolicy?: OutboxFailurePolicy;
}

export class EventOutbox {
  private readonly _store: OutboxStore;
  private readonly _transport?: EventTransport;
  private readonly _batchSize: number;
  private readonly _consumerId: string;
  private readonly _leaseMs: number;
  private readonly _onError?: OutboxRelayErrorHandler;
  private readonly _usePublishMany: boolean;
  private readonly _failurePolicy?: OutboxFailurePolicy;
  /**
   * In-process attempt counter per event id. Accurate within this relay
   * process; resets on restart. Populated as failures occur and cleared on
   * successful ack or dead-letter transition. For durable authoritative
   * counts, apps can query the store directly inside {@link OutboxFailurePolicy}.
   */
  private readonly _attempts = new Map<string, number>();

  constructor(opts: EventOutboxOptions) {
    // Resolve store: repository takes precedence; fall back to explicit
    // store; error if neither is given. The repository path uses an inline
    // adapter (no public wrapper class) — see `repositoryAsOutboxStore` at
    // the bottom of this file.
    if (opts.repository) {
      this._store = repositoryAsOutboxStore(opts.repository);
    } else if (opts.store) {
      this._store = opts.store;
    } else {
      throw new Error(
        "EventOutbox: either `repository` or `store` must be provided. " +
          "Pass a RepositoryLike (mongokit / prismakit) for the common case, " +
          "or a concrete OutboxStore (memory / custom) for non-repository backends.",
      );
    }
    this._transport = opts.transport;
    this._batchSize = opts.batchSize ?? 100;
    this._consumerId = opts.consumerId ?? `relay-${Math.random().toString(36).slice(2, 10)}`;
    this._leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this._onError = opts.onError;
    this._usePublishMany = opts.usePublishMany ?? true;
    this._failurePolicy = opts.failurePolicy;
  }

  /** Unique consumer ID used for lease ownership when the store supports claims */
  get consumerId(): string {
    return this._consumerId;
  }

  /**
   * Store event in outbox.
   *
   * Validates that `event.type` and `event.meta.id` are present — throws
   * {@link InvalidOutboxEventError} otherwise, so corrupt rows can never
   * be persisted via this API.
   *
   * Pass `options.session` to participate in a host-managed DB transaction
   * (store must support session-aware writes). Other options (`visibleAt`,
   * `dedupeKey`, `partitionKey`, `headers`) are forwarded to stores that
   * implement them and ignored otherwise.
   */
  async store(event: DomainEvent, options?: OutboxWriteOptions): Promise<void> {
    if (!event || typeof event !== "object") {
      throw new InvalidOutboxEventError("event is not an object");
    }
    if (!event.type || typeof event.type !== "string") {
      throw new InvalidOutboxEventError("event.type is required");
    }
    if (!event.meta?.id || typeof event.meta.id !== "string") {
      throw new InvalidOutboxEventError("event.meta.id is required");
    }

    // Auto-map event.meta.idempotencyKey → OutboxWriteOptions.dedupeKey when
    // the caller hasn't set one. Closes the common footgun where the event
    // carries an idempotency hint but the outbox persists duplicates because
    // the caller forgot to pass it twice.
    const effectiveOptions: OutboxWriteOptions | undefined =
      options?.dedupeKey === undefined && event.meta.idempotencyKey
        ? { ...(options ?? {}), dedupeKey: event.meta.idempotencyKey }
        : options;

    await this._store.save(event, effectiveOptions);
  }

  private _reportError(kind: OutboxRelayErrorKind, error: unknown, event?: DomainEvent): void {
    if (!this._onError) return;
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      this._onError({ kind, event, error: err });
    } catch {
      // onError must not throw — swallow to protect relay loop
    }
  }

  /**
   * Relay pending events to transport and return the number of successful
   * publish+acknowledge pairs.
   *
   * For richer observability (per-kind counts, publishMany detection, etc.)
   * use {@link relayBatch} which returns a {@link RelayResult}. This method
   * is the backward-compatible shortcut that returns just the count.
   *
   * @returns Number of successfully published AND acknowledged events
   */
  async relay(): Promise<number> {
    const result = await this.relayBatch();
    return result.relayed;
  }

  /**
   * Relay a batch of pending events to the transport and return a rich
   * {@link RelayResult} describing the outcome of each event.
   *
   * Behavior summary:
   *
   * - **Claim path**: uses {@link OutboxStore.claimPending} when the store
   *   supports it (safe for multi-worker relay) or falls back to
   *   {@link OutboxStore.getPending} (single-worker only).
   *
   * - **Publish path**: if the transport implements
   *   {@link EventTransport.publishMany} and `usePublishMany` is not disabled,
   *   the entire batch is sent in one call. Otherwise each event is published
   *   individually. Either way, per-event outcomes are tracked.
   *
   * - **Failure path**: if the store implements `fail`, per-event failures
   *   are reported via `store.fail(...)` and the batch continues. Without
   *   `fail`, the batch stops on the first failure (legacy behavior).
   *
   * - **Malformed events**: events missing `type` or `meta.id` abort the
   *   batch — a well-behaved store must never return them (see
   *   {@link OutboxStore} semantics #6). The error is reported via `onError`.
   *
   * - **Ownership mismatches**: if `acknowledge`/`fail` throws
   *   {@link OutboxOwnershipError} (our lease expired and another worker
   *   claimed the event), the event is NOT counted as relayed. The other
   *   worker will re-publish — at-least-once semantics preserved.
   *
   * @returns Per-kind outcome counts for the batch
   */
  async relayBatch(): Promise<RelayResult> {
    const empty: RelayResult = {
      relayed: 0,
      attempted: 0,
      publishFailed: 0,
      ackFailed: 0,
      ownershipMismatches: 0,
      malformed: 0,
      failHookErrors: 0,
      deadLettered: 0,
      usedPublishMany: false,
    };
    if (!this._transport) return empty;

    const pending = this._store.claimPending
      ? await this._store.claimPending({
          limit: this._batchSize,
          consumerId: this._consumerId,
          leaseMs: this._leaseMs,
        })
      : await this._store.getPending(this._batchSize);

    // Split pending into malformed (abort-inducing) and valid events.
    // A malformed event aborts the batch — we drop everything after it.
    const valid: DomainEvent[] = [];
    let malformed = 0;
    for (const event of pending) {
      if (!event || !event.type || !event.meta?.id) {
        this._reportError(
          "malformed_event",
          new InvalidOutboxEventError(
            "store returned event missing type or meta.id — batch aborted",
          ),
          event,
        );
        malformed++;
        break;
      }
      valid.push(event);
    }

    const counts = {
      relayed: 0,
      publishFailed: 0,
      ackFailed: 0,
      ownershipMismatches: 0,
      failHookErrors: 0,
      deadLettered: 0,
    };

    // Decide publish strategy: batched vs per-event
    const canPublishMany =
      this._usePublishMany && typeof this._transport.publishMany === "function";
    const canFail = typeof this._store.fail === "function";

    // Outcome map: eventId → null (success) or Error (failure)
    let publishOutcomes: Map<string, Error | null>;

    if (canPublishMany && valid.length > 0) {
      try {
        const result = await this._transport.publishMany!(valid);
        publishOutcomes = new Map(result);
      } catch (batchErr) {
        // Whole-batch failure — synthesize a uniform failure outcome so the
        // downstream fail/ack logic still runs per event.
        publishOutcomes = new Map();
        const err = batchErr instanceof Error ? batchErr : new Error(String(batchErr));
        for (const ev of valid) publishOutcomes.set(ev.meta.id, err);
      }
    } else {
      // Per-event publish path — respects legacy "stop on first failure"
      // behavior when the store has no `fail` method, because remaining
      // events need to stay pending in FIFO order.
      publishOutcomes = new Map();
      for (const event of valid) {
        try {
          await this._transport.publish(event);
          publishOutcomes.set(event.meta.id, null);
        } catch (err) {
          publishOutcomes.set(event.meta.id, err instanceof Error ? err : new Error(String(err)));
          // Without fail(), don't publish events after the failed one —
          // they must stay pending so relay retries in order next time.
          if (!canFail) break;
        }
      }
    }

    let stopBatch = false;

    // Apply ack/fail per event based on publish outcome. Order of `valid`
    // is preserved so legacy "stop on first failure" behavior works.
    for (const event of valid) {
      if (stopBatch) break;

      const publishErr = publishOutcomes.get(event.meta.id);
      if (publishErr instanceof Error) {
        counts.publishFailed++;
        this._reportError("publish_failed", publishErr, event);
        if (!canFail) {
          // Legacy: stop the batch on the first failure
          stopBatch = true;
          continue;
        }

        // Track attempts in-process; pass to the policy if configured. First
        // failure = attempts: 1, second = 2, etc. Cleared on ack or when the
        // event is dead-lettered (terminal state).
        const attempts = (this._attempts.get(event.meta.id) ?? 0) + 1;
        this._attempts.set(event.meta.id, attempts);

        let failOpts: OutboxFailOptions = { consumerId: this._consumerId };
        if (this._failurePolicy) {
          try {
            const decision = await this._failurePolicy({
              event,
              error: publishErr,
              attempts,
            });
            failOpts = { ...failOpts, ...decision };
          } catch (policyErr) {
            // Policy must not break the relay — fall back to default fail() call
            this._reportError("fail_failed", policyErr, event);
          }
        }

        try {
          await this._store.fail!(event.meta.id, normalizeError(publishErr), failOpts);
          if (failOpts.deadLetter) {
            counts.deadLettered++;
            this._attempts.delete(event.meta.id);
          }
        } catch (failErr) {
          if (failErr instanceof OutboxOwnershipError) {
            counts.ownershipMismatches++;
            this._reportError("ownership_mismatch", failErr, event);
          } else {
            counts.failHookErrors++;
            this._reportError("fail_failed", failErr, event);
          }
        }
        continue;
      }

      // Published successfully — acknowledge
      try {
        await this._store.acknowledge(event.meta.id, {
          consumerId: this._consumerId,
        });
        counts.relayed++;
        this._attempts.delete(event.meta.id);
      } catch (ackErr) {
        counts.ackFailed++;
        if (ackErr instanceof OutboxOwnershipError) {
          counts.ownershipMismatches++;
          this._reportError("ownership_mismatch", ackErr, event);
        } else {
          this._reportError("acknowledge_failed", ackErr, event);
        }
      }
    }

    return {
      relayed: counts.relayed,
      attempted: valid.length,
      publishFailed: counts.publishFailed,
      ackFailed: counts.ackFailed,
      ownershipMismatches: counts.ownershipMismatches,
      malformed,
      failHookErrors: counts.failHookErrors,
      deadLettered: counts.deadLettered,
      usedPublishMany: canPublishMany && valid.length > 0,
    };
  }

  /**
   * Fetch current dead-lettered events as typed {@link DeadLetteredEvent}
   * envelopes. Delegates to {@link OutboxStore.getDeadLettered} — returns
   * `[]` when the store doesn't implement it.
   *
   * Pairs with {@link OutboxFailurePolicy}: apps set a policy that routes to
   * `deadLetter: true` after N attempts, then read back with this to alert,
   * replay, or archive.
   */
  async getDeadLettered(limit = 100): Promise<DeadLetteredEvent[]> {
    if (!this._store.getDeadLettered) return [];
    return this._store.getDeadLettered(limit);
  }

  /**
   * Purge old **delivered** events from the outbox store.
   * Delegates to `store.purge()` if implemented; no-op otherwise.
   * @param olderThanMs - Remove events delivered more than this many ms ago (default: 7 days)
   * @returns Number of purged events, or 0 if store doesn't support purge
   */
  async purge(olderThanMs = DEFAULT_OUTBOX_RETENTION_MS): Promise<number> {
    if (!this._store.purge) return 0;
    return this._store.purge(olderThanMs);
  }
}

function normalizeError(err: unknown): OutboxErrorInfo {
  if (err instanceof Error) {
    return {
      message: err.message,
      code: (err as Error & { code?: string }).code,
    };
  }
  return { message: String(err) };
}

// ============================================================================
// Retry helpers — utilities for store authors implementing `fail()` with backoff
// ============================================================================

/**
 * Options for {@link exponentialBackoff}.
 */
export interface ExponentialBackoffOptions {
  /** Current attempt count (1-indexed — first retry is attempt 1) */
  readonly attempt: number;
  /** Base delay in ms (first retry delay). Default: 1000 (1 second) */
  readonly baseMs?: number;
  /** Maximum delay in ms — caps exponential growth. Default: 60_000 (1 minute) */
  readonly maxMs?: number;
  /**
   * Jitter factor [0–1]. The returned delay is multiplied by
   * `1 + (random * jitter)` to spread retry bursts across workers.
   * Default: 0.2 (±20%). Set to 0 to disable.
   */
  readonly jitter?: number;
  /** Reference time (for deterministic tests). Default: `Date.now()` */
  readonly now?: number;
}

/**
 * Compute a `retryAt` `Date` using exponential backoff with jitter.
 *
 * This is a convenience helper for store authors implementing
 * {@link OutboxStore.fail}: call it to compute the retry visibility window
 * based on the event's current attempt count.
 *
 * Formula: `delay = min(maxMs, baseMs * 2^(attempt - 1)) * (1 + random * jitter)`
 *
 * @example Basic usage inside a store's `fail()` method
 * ```typescript
 * async fail(eventId, error, options) {
 *   const entry = await this.findById(eventId);
 *   entry.attempts++;
 *   if (entry.attempts >= MAX_ATTEMPTS) {
 *     return this.deadLetter(eventId, error);
 *   }
 *   const retryAt = exponentialBackoff({ attempt: entry.attempts });
 *   entry.visibleAt = retryAt;
 *   await this.update(entry);
 * }
 * ```
 *
 * @example Tuning for a faster transport
 * ```typescript
 * exponentialBackoff({ attempt: 3, baseMs: 250, maxMs: 10_000, jitter: 0.3 });
 * // attempt=1 → ~250ms   ±30%
 * // attempt=2 → ~500ms   ±30%
 * // attempt=3 → ~1000ms  ±30%
 * // attempt=10 → capped at 10_000ms
 * ```
 */
export function exponentialBackoff(options: ExponentialBackoffOptions): Date {
  const attempt = Math.max(1, Math.floor(options.attempt));
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 60_000;
  const jitter = Math.max(0, Math.min(1, options.jitter ?? 0.2));
  const now = options.now ?? Date.now();

  // Exponential growth: base * 2^(attempt-1), capped at maxMs
  const exp = baseMs * 2 ** (attempt - 1);
  const capped = Math.min(maxMs, exp);

  // Apply jitter (always additive — never schedules earlier than `capped`)
  const jittered = jitter > 0 ? capped * (1 + Math.random() * jitter) : capped;

  return new Date(now + jittered);
}
