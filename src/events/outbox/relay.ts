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
import { evictToSize, touch } from "../../collections/boundedMap.js";
import type { DeadLetteredEvent, DomainEvent, EventTransport } from "../EventTransport.js";
import { repositoryAsOutboxStore } from "../repository-outbox-adapter.js";
import { claimedAttempts } from "./claimed.js";

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
/**
 * Share of the lease a pass may spend before it stops publishing claimed rows.
 * The rest absorbs the last publish + ack and clock skew between claimants: a
 * row published after its lease expired may already be re-claimed elsewhere.
 */
const LEASE_PUBLISH_FRACTION = 0.8;
/** Share of the lease the adaptive claim sizes a batch to, from the measured per-event time. */
const LEASE_CLAIM_FRACTION = 0.5;

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
/** Options for one {@link EventOutbox.relayBatch} pass. */
export interface RelayBatchOptions {
  /**
   * Claim only events of these types (exact names). A priority pass: rows of
   * other types stay pending for the next untyped pass. Empty = all types.
   */
  readonly types?: readonly string[];
}

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
  /**
   * Claimed rows NOT published because the lease budget ran out first. They
   * stay leased to this relay and are re-claimed (unpublished) after expiry;
   * counted in `attempted`.
   */
  readonly leaseDeferred?: number;
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
   *
   * A pass publishes a claimed row only while its lease has budget left, and
   * sizes later claims to fit the lease from the measured per-event time, so
   * this must exceed the slowest SINGLE publish + ack, not a whole batch.
   */
  readonly leaseMs?: number;
  /**
   * Callback for non-fatal errors during relay: publish failures,
   * ownership mismatches, ack/fail errors, malformed events. Use this for
   * logging and metrics. Must not throw — exceptions are swallowed.
   */
  readonly onError?: OutboxRelayErrorHandler;
  /** Called with each event the transport accepted — observation only, never affects the batch. */
  readonly onPublished?: (event: DomainEvent) => void;
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
  private readonly _onPublished?: (event: DomainEvent) => void;
  private readonly _usePublishMany: boolean;
  private readonly _sessionProvider?: () => unknown;
  private readonly _traceContextProvider?: () => Record<string, string> | undefined;
  private readonly _failurePolicy?: OutboxFailurePolicy;
  /**
   * In-process attempt counter per event id. Accurate within this relay
   * process; resets on restart. Populated as failures occur and cleared on
   * successful ack or dead-letter transition; additionally hard-capped at
   * {@link MAX_TRACKED_ATTEMPTS} (oldest-write evicted first) so events
   * resolved by another relay worker can't accumulate forever.
   *
   * A FALLBACK only: when the store reports `attempts` on the fenced claim
   * (`repositoryAsOutboxStore` and primitives' `MemoryOutboxStore` do), the
   * durable count wins — see the failure path in `relayBatch`.
   */
  private readonly _attempts = new Map<string, number>();
  /**
   * Measured ms per event (publish + ack), rising at once on a slower batch and
   * decaying slowly. Undefined until a batch has published something.
   */
  private _perEventMs: number | undefined;

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
    this._onPublished = opts.onPublished;
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
   * Rows claimed per {@link relayBatch} (the `batchSize` option, default 100), lowered to
   * the store's `claimCap` once a claim came back clamped (`repositoryAsOutboxStore`).
   * A pass that attempted this many rows hit the limit, so more may be pending.
   */
  get batchSize(): number {
    const cap = (this._store as { readonly claimCap?: unknown }).claimCap;
    return typeof cap === "number" && cap > 0 ? Math.min(this._batchSize, cap) : this._batchSize;
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
   * - **Types**: `options.types` claims only events of those types (exact
   *   names, oldest first), so a priority pass is not queued behind a backlog
   *   of other types. Needs a store with `claimPending` / `claimPendingFenced`
   *   (both honour `OutboxClaimOptions.types`); on the single-worker
   *   `getPending` fallback the filter is ignored and the oldest rows go out.
   *
   * - **Lease budget**: on a leasing store each row is published only while
   *   the claim's lease has budget left, and acked right after its publish.
   *   Rows past the budget are not published (`leaseDeferred`); they are
   *   re-claimed after expiry. The claim size adapts to the measured per-event
   *   time so a batch fits the lease. See wiki/delivery-guarantees.md.
   *
   * @returns Per-kind outcome counts for the batch
   */
  async relayBatch(options?: RelayBatchOptions): Promise<RelayResult> {
    const types = options?.types?.length ? options.types : undefined;
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
    const leased =
      typeof this._store.claimPendingFenced === "function" ||
      typeof this._store.claimPending === "function";
    const limit = leased ? this._claimLimit() : this.batchSize;
    // Fencing (feature-detected end to end): prefer the fenced claim and
    // carry each event's store-minted token into ack/fail, where a fencing
    // store rejects a stale epoch — the overlap consumer-id ownership
    // narrows but cannot close (holder ids recur; epochs do not).
    const fenceTokens = new Map<string, number>();
    // Durable per-event attempt counts, when the store reports them on the
    // fenced claim. See `_attempts` for why the in-process count alone is wrong.
    const durableAttempts = new Map<string, number>();
    let pending: DomainEvent[];
    if (typeof this._store.claimPendingFenced === "function") {
      const claimed = await this._store.claimPendingFenced({
        limit,
        consumerId: this._consumerId,
        leaseMs: this._leaseMs,
        ...(types ? { types } : {}),
      });
      pending = claimed.map((c) => {
        if (c.event?.meta?.id) {
          fenceTokens.set(c.event.meta.id, c.fencingToken);
          const attempts = claimedAttempts(c);
          if (attempts !== undefined) durableAttempts.set(c.event.meta.id, attempts);
        }
        return c.event;
      });
    } else if (this._store.claimPending) {
      pending = await this._store.claimPending({
        limit,
        consumerId: this._consumerId,
        leaseMs: this._leaseMs,
        ...(types ? { types } : {}),
      });
    } else {
      pending = await this._store.getPending(this.batchSize);
    }
    const claimMs = Date.now() - claimStartedAt;
    const publishStartedAt = Date.now();
    // The ownership check before each publish. Measured from BEFORE the claim,
    // so it is never later than the store's own expiry: until it passes, no
    // other claimant can hold these rows. `getPending` has no lease to keep.
    const leaseDeadline = leased
      ? claimStartedAt + this._leaseMs * LEASE_PUBLISH_FRACTION
      : Number.POSITIVE_INFINITY;

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

    const settleCtx: SettleContext = { canFail, counts, fenceTokens, durableAttempts };
    /** Rows published and settled (ack/fail) this batch, and their summed time. */
    let settled = 0;
    let settleMs = 0;
    let leaseDeferred = 0;

    if (canPublishMany && valid.length > 0) {
      if (Date.now() >= leaseDeadline) {
        leaseDeferred = valid.length;
      } else {
        const startedAt = Date.now();
        // Outcome map: eventId → null (success) or Error (failure)
        let publishOutcomes: Map<string, Error | null>;
        try {
          const result = await this._transport.publishMany?.(valid);
          publishOutcomes = batchOutcomes(valid, result);
        } catch (batchErr) {
          // Whole-batch failure — synthesize a uniform failure outcome so the
          // downstream fail/ack logic still runs per event.
          publishOutcomes = new Map();
          const err = batchErr instanceof Error ? batchErr : new Error(String(batchErr));
          for (const ev of valid) publishOutcomes.set(ev.meta.id, err);
        }
        for (const event of valid) {
          if (publishOutcomes.get(event.meta.id) === null) this._notifyPublished(event);
        }
        for (const event of valid) {
          if (await this._settle(event, publishOutcomes.get(event.meta.id) ?? null, settleCtx)) {
            break;
          }
        }
        settled = valid.length;
        settleMs = Date.now() - startedAt;
      }
    } else {
      // Per-event path: publish, then ack/fail AT ONCE, so each row is settled
      // inside its lease rather than after the whole batch. Without `fail()`
      // the batch stops at the first failure: later rows stay pending in order.
      for (const [index, event] of valid.entries()) {
        const nextMs = Math.max(settled > 0 ? settleMs / settled : 0, this._perEventMs ?? 0);
        if (Date.now() + nextMs > leaseDeadline) {
          leaseDeferred = valid.length - index;
          break;
        }
        const startedAt = Date.now();
        let publishErr: Error | null = null;
        try {
          await this._transport.publish(event);
        } catch (err) {
          publishErr = err instanceof Error ? err : new Error(String(err));
        }
        if (publishErr === null) this._notifyPublished(event);
        const stop = await this._settle(event, publishErr, settleCtx);
        settled++;
        settleMs += Date.now() - startedAt;
        if (stop) break;
      }
    }
    if (settled > 0) this._recordPerEventMs(settleMs / settled);

    return {
      relayed: counts.relayed,
      attempted: valid.length,
      publishFailed: counts.publishFailed,
      ackFailed: counts.ackFailed,
      ownershipMismatches: counts.ownershipMismatches,
      malformed,
      failHookErrors: counts.failHookErrors,
      deadLettered: counts.deadLettered,
      usedPublishMany: canPublishMany && valid.length > 0 && leaseDeferred < valid.length,
      claimMs,
      publishMs: Date.now() - publishStartedAt,
      ...(leaseDeferred > 0 ? { leaseDeferred } : {}),
    };
  }

  /**
   * Rows to claim: `batchSize`, or fewer when the measured per-event time says a
   * full batch would outlive {@link LEASE_CLAIM_FRACTION} of the lease.
   */
  private _claimLimit(): number {
    const batchSize = this.batchSize;
    if (this._perEventMs === undefined || this._perEventMs <= 0) return batchSize;
    const fit = Math.floor((this._leaseMs * LEASE_CLAIM_FRACTION) / this._perEventMs);
    return Math.max(1, Math.min(batchSize, fit));
  }

  private _recordPerEventMs(sample: number): void {
    const prev = this._perEventMs;
    this._perEventMs = prev === undefined ? sample : Math.max(sample, prev * 0.7 + sample * 0.3);
  }

  private _notifyPublished(event: DomainEvent): void {
    if (!this._onPublished) return;
    try {
      this._onPublished(event);
    } catch {
      /* observation never affects the batch */
    }
  }

  /**
   * Ack a published event, or `fail()` a rejected one. Returns `true` when the
   * batch must stop (a failure on a store without `fail`).
   */
  private async _settle(
    event: DomainEvent,
    publishErr: Error | null,
    ctx: SettleContext,
  ): Promise<boolean> {
    const { canFail, counts, fenceTokens, durableAttempts } = ctx;
    if (publishErr instanceof Error) {
      counts.publishFailed++;
      this._reportError("publish_failed", publishErr, event);
      if (!canFail) {
        // Legacy: stop the batch on the first failure
        return true;
      }

      // Track attempts in-process; pass to the policy if configured. First
      // failure = attempts: 1, second = 2, etc. Cleared on ack or when the
      // event is dead-lettered (terminal state).
      //
      // The in-process count is only a FALLBACK. It restarts at 1 on every
      // relay boot — so a poison event that crashes the relay never reaches
      // `attempts >= N → deadLetter` — and every relay on a shared store keeps
      // its own, so N means N × relays. When the store reports the durable
      // count on the fenced claim, that one wins; `max` covers a store whose
      // counter lags (e.g. one that only bumps it on `fail`).
      const localAttempts = (this._attempts.get(event.meta.id) ?? 0) + 1;
      const attempts = Math.max(localAttempts, durableAttempts.get(event.meta.id) ?? 0);
      // delete-then-set keeps actively-failing ids at the tail of the
      // Map's insertion order, so the cap below evicts the STALEST entry
      // (most likely already acked by another worker after lease expiry).
      touch(this._attempts, event.meta.id, attempts);
      evictToSize(this._attempts, MAX_TRACKED_ATTEMPTS);

      const fenceToken = fenceTokens.get(event.meta.id);
      let failOpts: OutboxFailOptions = {
        consumerId: this._consumerId,
        ...(fenceToken !== undefined ? { fencingToken: fenceToken } : {}),
      };
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
      return false;
    }

    // Published successfully — acknowledge
    try {
      const ackFenceToken = fenceTokens.get(event.meta.id);
      await this._store.acknowledge(event.meta.id, {
        consumerId: this._consumerId,
        ...(ackFenceToken !== undefined ? { fencingToken: ackFenceToken } : {}),
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
    return false;
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

/** Per-batch state {@link EventOutbox} threads into `_settle`. */
interface SettleContext {
  readonly canFail: boolean;
  readonly counts: {
    relayed: number;
    publishFailed: number;
    ackFailed: number;
    ownershipMismatches: number;
    failHookErrors: number;
    deadLettered: number;
  };
  readonly fenceTokens: ReadonlyMap<string, number>;
  readonly durableAttempts: ReadonlyMap<string, number>;
}

/**
 * A `publishMany` result must name exactly the events it was given. A missing outcome would read as
 * success and be ACKNOWLEDGED unpublished, so any mismatch fails the whole batch — nothing is acked.
 */
function batchOutcomes(
  events: readonly DomainEvent[],
  result: ReadonlyMap<string, Error | null> | undefined,
): Map<string, Error | null> {
  const problem = batchContractProblem(events, result);
  if (!problem) return new Map(result);
  const err = new Error(
    `[arc outbox] transport publishMany ${problem} — the whole batch is failed, none acknowledged`,
  );
  return new Map(events.map((e) => [e.meta.id, err]));
}

function batchContractProblem(
  events: readonly DomainEvent[],
  result: ReadonlyMap<string, Error | null> | undefined,
): string | undefined {
  if (!(result instanceof Map)) return "returned no outcome map";
  const ids = new Set(events.map((e) => e.meta.id));
  for (const id of ids) if (!result.has(id)) return `returned no outcome for event '${id}'`;
  for (const id of result.keys())
    if (!ids.has(id)) return `returned an outcome for unknown event '${id}'`;
  return undefined;
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
