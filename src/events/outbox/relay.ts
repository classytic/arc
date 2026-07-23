/**
 * EventOutbox — the claim/lease relay engine over any `OutboxStore`.
 *
 * The outbox CONTRACT (`OutboxStore`, option types, `OutboxOwnershipError`,
 * `InvalidOutboxEventError`) is owned by `@classytic/primitives/outbox`
 * (>=0.13) — arc does not re-export it; hosts and domain packages import it
 * from primitives directly. Arc owns the RUNTIME in this directory:
 *
 *   relay.ts   — `EventOutbox` (this file), `RelayResult`
 *   backoff.ts — `exponentialBackoff` helper for failure policies
 *   index.ts   — barrel; `src/events/outbox.ts` re-exports it
 *
 * Terminology (v2.8.1+): **`delivered`** is the canonical state for
 * "published to the transport and marked by `acknowledge()`"; stores use a
 * `deliveredAt` timestamp field.
 */

import type {
  OutboxErrorInfo,
  OutboxFailOptions,
  OutboxFailurePolicy,
  OutboxStore,
  OutboxWriteOptions,
} from "@classytic/primitives/outbox";
import { InvalidOutboxEventError, OutboxOwnershipError } from "@classytic/primitives/outbox";
import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { DeadLetteredEvent, DomainEvent, EventTransport } from "../EventTransport.js";
import { repositoryAsOutboxStore } from "../repository-outbox-adapter.js";

/** Default outbox retention — delivered events older than this are eligible for purge */
const DEFAULT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_LEASE_MS = 30_000;
/**
 * Hard cap on the in-process attempt-counter map. Entries are cleared on
 * local ack and on dead-letter, but an event that fails HERE and is later
 * acked by a DIFFERENT relay worker (lease expiry → reclaim) never drains
 * locally — without a cap the map grows for the life of the process in
 * multi-worker deployments. Eviction is oldest-write-first; evicting an
 * entry only resets its non-authoritative in-process count (the documented
 * contract already says counts reset on restart — durable counts live in
 * the store).
 */
const MAX_TRACKED_ATTEMPTS = 10_000;

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
  /**
   * Wall-clock ms spent claiming this batch from the store. With the
   * portable repository adapter this is ~2 DB round trips; a persistently
   * high value under low batch sizes points at store latency, not volume.
   */
  readonly claimMs?: number;
  /** Wall-clock ms spent publishing + acknowledging the batch. */
  readonly publishMs?: number;
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
  /**
   * Unit-of-Work session provider (AsyncLocalStorage integration).
   *
   * When set, `store()` calls this to get the active DB session and uses
   * it as `OutboxWriteOptions.session` — **only when the caller has not
   * already passed an explicit `options.session`**. This eliminates the
   * boilerplate of threading the transaction handle from the controller
   * through every service layer down to the outbox call site.
   *
   * Wire up with arc's `transactionContext`:
   * ```typescript
   * import { transactionContext } from '@classytic/arc/context';
   *
   * const outbox = new EventOutbox({
   *   store: myOutboxStore,
   *   sessionProvider: () => transactionContext.get(),
   * });
   *
   * // In your service layer — session is auto-picked up:
   * await transactionContext.run(mongooseSession, async () => {
   *   await orders.insertOne(order, { session: mongooseSession });
   *   await outbox.store(orderCreatedEvent); // no session arg needed
   * });
   * ```
   */
  readonly sessionProvider?: () => unknown;
  /**
   * W3C Trace Context provider.
   *
   * When set, `store()` calls this and merges the returned headers into
   * `OutboxWriteOptions.headers` — only when `traceparent` is not already
   * present in the caller-supplied headers. Downstream relay workers can
   * then forward the headers to the transport, preserving the distributed
   * trace tree across service boundaries.
   *
   * Wire up with arc's `getTraceHeaders`:
   * ```typescript
   * import { getTraceHeaders } from '@classytic/arc/context';
   *
   * const outbox = new EventOutbox({
   *   store: myOutboxStore,
   *   traceContextProvider: getTraceHeaders,
   * });
   * ```
   */
  readonly traceContextProvider?: () => Record<string, string> | undefined;
}

export class EventOutbox {
  private readonly _store: OutboxStore;
  private readonly _transport?: EventTransport;
  private readonly _batchSize: number;
  private readonly _consumerId: string;
  private readonly _leaseMs: number;
  private readonly _onError?: OutboxRelayErrorHandler;
  private readonly _usePublishMany: boolean;
  private readonly _sessionProvider?: () => unknown;
  private readonly _traceContextProvider?: () => Record<string, string> | undefined;
  private readonly _failurePolicy?: OutboxFailurePolicy;
  /**
   * In-process attempt counter per event id. Accurate within this relay
   * process; resets on restart. Populated as failures occur and cleared on
   * successful ack or dead-letter transition; additionally hard-capped at
   * {@link MAX_TRACKED_ATTEMPTS} (oldest-write evicted first) so events
   * resolved by another relay worker can't accumulate forever. For durable
   * authoritative counts, apps can query the store directly inside
   * {@link OutboxFailurePolicy}.
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
    this._sessionProvider = opts.sessionProvider;
    this._traceContextProvider = opts.traceContextProvider;
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

    // Build effective options, auto-injecting from providers only when the
    // caller hasn't supplied an explicit value. `undefined` is preserved
    // unless at least one injection or enrichment actually adds something —
    // this keeps the contract stable for custom stores that distinguish
    // `undefined` from `{}`.
    let effective: OutboxWriteOptions | undefined = options;

    // Auto-inject DB session from UoW provider (explicit session always wins).
    if (effective?.session === undefined && this._sessionProvider) {
      const autoSession = this._sessionProvider();
      if (autoSession !== undefined) {
        effective = { ...(effective ?? {}), session: autoSession };
      }
    }

    // Auto-inject W3C trace headers (explicit traceparent always wins).
    if (!effective?.headers?.traceparent && this._traceContextProvider) {
      const traceHeaders = this._traceContextProvider();
      if (traceHeaders && Object.keys(traceHeaders).length > 0) {
        effective = {
          ...(effective ?? {}),
          headers: { ...traceHeaders, ...(effective?.headers ?? {}) },
        };
      }
    }

    // Auto-map event.meta.idempotencyKey → OutboxWriteOptions.dedupeKey when
    // the caller hasn't set one. Closes the common footgun where the event
    // carries an idempotency hint but the outbox persists duplicates because
    // the caller forgot to pass it twice.
    if (effective?.dedupeKey === undefined && event.meta.idempotencyKey) {
      effective = { ...(effective ?? {}), dedupeKey: event.meta.idempotencyKey };
    }

    await this._store.save(event, effective);
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

    const claimStartedAt = Date.now();
    const pending = this._store.claimPending
      ? await this._store.claimPending({
          limit: this._batchSize,
          consumerId: this._consumerId,
          leaseMs: this._leaseMs,
        })
      : await this._store.getPending(this._batchSize);
    const claimMs = Date.now() - claimStartedAt;
    const publishStartedAt = Date.now();

    // Split pending into malformed (abort-inducing) and valid events.
    // A malformed event aborts the batch — we drop everything after it.
    const valid: DomainEvent[] = [];
    let malformed = 0;
    for (const event of pending) {
      if (!event?.type || !event.meta?.id) {
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
        const result = await this._transport.publishMany?.(valid);
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
        // delete-then-set keeps actively-failing ids at the tail of the
        // Map's insertion order, so the cap below evicts the STALEST entry
        // (most likely already acked by another worker after lease expiry).
        this._attempts.delete(event.meta.id);
        this._attempts.set(event.meta.id, attempts);
        if (this._attempts.size > MAX_TRACKED_ATTEMPTS) {
          const oldest = this._attempts.keys().next().value;
          if (oldest !== undefined) this._attempts.delete(oldest);
        }

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
          await this._store.fail?.(event.meta.id, normalizeError(publishErr), failOpts);
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
      claimMs,
      publishMs: Date.now() - publishStartedAt,
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
