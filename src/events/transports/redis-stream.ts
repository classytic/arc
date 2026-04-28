/**
 * Redis Stream Event Transport — Durable Event Delivery
 *
 * Uses Redis Streams (`XADD`/`XREADGROUP`) for persistent, at-least-once event
 * delivery across multiple service instances. Unlike Pub/Sub, events are stored
 * in Redis and survive crashes/restarts.
 *
 * **Delivery guarantee:** at-least-once. Failed messages are left unacked and
 * reclaimed after `claimTimeoutMs`, which can result in duplicate handler
 * execution. Consumers must be idempotent (e.g. use `event.meta.id` as a
 * deduplication key) to achieve effectively-once processing.
 *
 * Key features:
 * - Consumer groups: each event delivered to exactly one consumer per group
 * - Crash recovery: pending entries are auto-claimed after `claimTimeoutMs`
 * - Dead letter stream: events exceeding `maxRetries` are moved to a DLQ
 * - Backpressure: configurable block time and batch size
 *
 * @example
 * ```typescript
 * import { RedisStreamTransport } from '@classytic/arc/events';
 * import Redis from 'ioredis';
 *
 * const transport = new RedisStreamTransport(new Redis(), {
 *   stream: 'arc-events',
 *   group: 'api-service',
 *   consumer: 'worker-1',
 * });
 *
 * await app.register(eventPlugin, { transport });
 * ```
 */

import type {
  DeadLetteredEvent,
  DomainEvent,
  EventHandler,
  EventLogger,
  EventTransport,
} from "../EventTransport.js";

// ---------------------------------------------------------------------------
// Minimal Redis-like interface for Streams support
// ---------------------------------------------------------------------------

export interface RedisStreamLike {
  xadd(key: string, id: string, ...fieldValues: string[]): Promise<string | null>;
  xreadgroup(
    command: "GROUP",
    group: string,
    consumer: string,
    ...args: (string | number)[]
  ): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  xack(key: string, group: string, ...ids: string[]): Promise<number>;
  xgroup(command: string, key: string, group: string, ...args: string[]): Promise<unknown>;
  xpending(
    key: string,
    group: string,
    ...args: (string | number)[]
  ): Promise<Array<[string, string, number, number]>>;
  xclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleTime: number,
    ...ids: string[]
  ): Promise<Array<[string, string[]]>>;
  xlen(key: string): Promise<number>;
  /**
   * Read a range of entries by id. When present, the DLQ writer uses this
   * to fetch the original message payload so dead-lettered events are
   * **fully replayable** (a re-publish of `envelope.event` is sufficient).
   *
   * Optional to preserve back-compat with custom Redis wrappers that
   * satisfied the pre-2.11.3 shape. When missing, the DLQ envelope still
   * carries the **error reason + attempt accounting** (operator-grade
   * triage info survives), but `envelope.event.payload` is `null` and
   * `envelope.event.type` is `<unknown>` — replay is NOT possible without
   * upgrading the client. A one-shot warning fires per process so this
   * isn't silent.
   */
  xrange?(key: string, start: string, end: string): Promise<Array<[string, string[]]>>;
  /** Graceful close — flushes queued commands then closes. ioredis-style. */
  quit(): Promise<unknown>;
  /**
   * Force-disconnect — closes the socket immediately, abandoning any
   * pending command (including a live `XREADGROUP BLOCK`). Optional because
   * non-ioredis clients may not expose a force path; `close()` falls back
   * to `quit()` when this is missing, accepting a longer shutdown wait.
   */
  disconnect?(): void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RedisStreamTransportOptions {
  /**
   * Redis stream key name.
   * @default 'arc:events'
   */
  stream?: string;

  /**
   * Consumer group name. Each group receives every event independently.
   * Multiple instances of the same service should share a group name.
   * @default 'default'
   */
  group?: string;

  /**
   * Consumer name within the group. Must be unique per instance.
   * @default 'consumer-<random>'
   */
  consumer?: string;

  /**
   * Block time in ms when waiting for new events.
   * @default 5000
   */
  blockTimeMs?: number;

  /**
   * Max events to read per batch.
   * @default 10
   */
  batchSize?: number;

  /**
   * Max delivery attempts before moving to dead letter stream.
   * @default 5
   */
  maxRetries?: number;

  /**
   * Idle time in ms before pending entries are claimed by this consumer.
   * Handles crash recovery — if a consumer dies mid-processing, another
   * consumer will claim its pending entries after this timeout.
   * @default 30000
   */
  claimTimeoutMs?: number;

  /**
   * Dead letter stream name. Failed events are moved here after maxRetries.
   * Set to `false` to disable DLQ (failed events are acked and dropped).
   * @default 'arc:events:dlq'
   */
  deadLetterStream?: string | false;

  /**
   * Max stream length (approximate). Uses XADD MAXLEN ~ to trim old entries.
   * Set to 0 to disable trimming.
   * @default 10000
   */
  maxLen?: number;

  /**
   * Max event payload size in bytes. Publish rejects events exceeding this limit
   * to prevent Redis memory exhaustion from oversized payloads.
   * @default 1_000_000 (1 MB)
   */
  maxPayloadBytes?: number;

  /**
   * If `true`, `close()` does NOT call `redis.quit()` — useful when the host
   * manages the Redis connection lifecycle externally (shared client across
   * multiple transports / cache stores). Without this, every transport
   * `close()` would tear down a shared client and break siblings.
   *
   * Mirror of `RedisEventTransportOptions.externalLifecycle`.
   * @default false
   */
  externalLifecycle?: boolean;

  /**
   * Hard cap on how long `close()` waits for the in-flight `XREADGROUP BLOCK`
   * iteration to drain. Tests and serverless shutdowns would otherwise hang
   * up to `blockTimeMs` (default 5s) per close.
   *
   * Behaviour after timeout:
   *   - `externalLifecycle: false` (default) — `redis.disconnect()` (or
   *     `quit()` if the client lacks `disconnect`) breaks the BLOCK
   *     immediately. Strict bounded close.
   *   - `externalLifecycle: true` — arc CANNOT touch the host's connection,
   *     so the poll loop is left to drain in the background when its
   *     XREADGROUP returns. `close()` returns within `closeTimeoutMs` but
   *     the loop's eventual completion is silently absorbed (no log spam,
   *     no unhandled rejection). The contract here is "bounded return,
   *     background drain" — set `blockTimeMs` low (e.g. 500ms) under
   *     externalLifecycle to keep the drain window short.
   *
   * @default 1000
   */
  closeTimeoutMs?: number;

  /**
   * Logger for error messages (default: console).
   * Pass `fastify.log` to integrate with your application logger.
   */
  logger?: EventLogger;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class RedisStreamTransport implements EventTransport {
  readonly name = "redis-stream";

  private redis: RedisStreamLike;
  private stream: string;
  private group: string;
  private consumer: string;
  private blockTimeMs: number;
  private batchSize: number;
  private maxRetries: number;
  private claimTimeoutMs: number;
  private deadLetterStream: string | false;
  private maxLen: number;
  private maxPayloadBytes: number;

  private logger: EventLogger;

  /** Tracks the lifecycle policy — set in constructor, read in close(). */
  private externalLifecycle: boolean;
  private closeTimeoutMs: number;

  private handlers = new Map<string, Set<EventHandler>>();
  private running = false;
  private pollPromise: Promise<void> | null = null;
  /**
   * Monotonic counter bumped every time the poll loop should stop —
   * `unsubscribe` (last handler removed) and `close()` increment it. Each
   * `pollLoop` instance captures its generation at start and exits when
   * `this.generation` no longer matches. Prevents the
   * subscribe → unsubscribe → fast-resubscribe race where the old loop
   * would still be in `XREADGROUP BLOCK` while a new loop started, leading
   * to two concurrent poll loops on the same consumer name.
   */
  private generation = 0;
  private groupCreated = false;

  /**
   * Last-seen failure context per message id, populated when an in-process
   * handler throws in {@link processEntry}. Consumed (and cleared) by
   * {@link moveToDlq} so the dead-letter envelope carries the actual error
   * message instead of opaque "reclaimed without context". Bounded by
   * `maxRetries × consumer-throughput` — entries are deleted on ack and
   * on DLQ write, so the map naturally drains.
   */
  private failureContext = new Map<
    string,
    {
      error: { message: string; code?: string; stack?: string };
      firstFailedAt: Date;
      lastFailedAt: Date;
      attempts: number;
      handlerName?: string;
    }
  >();

  /** One-shot guard so the "client lacks xrange" warning fires once per process. */
  private xrangeWarningEmitted = false;

  constructor(redis: RedisStreamLike, options: RedisStreamTransportOptions = {}) {
    this.redis = redis;
    this.stream = options.stream ?? "arc:events";
    this.group = options.group ?? "default";
    this.consumer = options.consumer ?? `consumer-${crypto.randomUUID().slice(0, 8)}`;
    this.blockTimeMs = options.blockTimeMs ?? 5000;
    this.batchSize = options.batchSize ?? 10;
    this.maxRetries = options.maxRetries ?? 5;
    this.claimTimeoutMs = options.claimTimeoutMs ?? 30_000;
    this.deadLetterStream = options.deadLetterStream ?? "arc:events:dlq";
    this.maxLen = options.maxLen ?? 10_000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 1_000_000;
    this.externalLifecycle = options.externalLifecycle ?? false;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 1000;
    this.logger = options.logger ?? console;
  }

  // -----------------------------------------------------------------------
  // EventTransport.publish
  // -----------------------------------------------------------------------

  async publish(event: DomainEvent): Promise<void> {
    const serialized = JSON.stringify(event);

    // Guard against oversized payloads that could exhaust Redis memory
    if (serialized.length > this.maxPayloadBytes) {
      throw new Error(
        `[RedisStreamTransport] Event payload (${serialized.length} bytes) exceeds limit (${this.maxPayloadBytes}). ` +
          "Consider breaking into smaller events or increasing maxPayloadBytes.",
      );
    }

    const args: string[] = [
      this.stream,
      ...(this.maxLen > 0 ? ["MAXLEN", "~", String(this.maxLen)] : []),
      "*",
      "type",
      event.type,
      "data",
      serialized,
    ];

    // Use spread to call xadd with dynamic args
    await (this.redis as any).xadd(...args);
  }

  // -----------------------------------------------------------------------
  // EventTransport.subscribe
  // -----------------------------------------------------------------------

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)?.add(handler);

    // Start the consumer loop if not already running. A prior loop from
    // a previous subscribe → unsubscribe cycle may still be draining its
    // last `XREADGROUP BLOCK`; we don't wait (subscribe must be fast) but
    // bumping the generation guarantees the old loop exits on its next
    // iteration instead of running alongside the new one.
    if (!this.running) {
      await this.ensureGroup();
      this.running = true;
      const myGen = ++this.generation;
      this.pollPromise = this.pollLoop(myGen).catch((err) => {
        this.logger.error("[RedisStreamTransport] Poll loop crashed:", err);
        // Only flip running off if we're still the active generation —
        // a newer loop may have started after a crash and we shouldn't
        // trample its state.
        if (this.generation === myGen) this.running = false;
      });
    }

    return () => {
      const set = this.handlers.get(pattern);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(pattern);
      }
      // Stop polling when no handlers remain — prevents CPU/network waste.
      // Bump generation so the in-flight loop exits on its next iteration.
      if (this.handlers.size === 0 && this.running) {
        this.running = false;
        this.generation++;
      }
    };
  }

  // -----------------------------------------------------------------------
  // EventTransport.close
  // -----------------------------------------------------------------------

  /**
   * Stop polling and release transport state.
   *
   * **Two close contracts** — pick the one that matches your deployment:
   *
   * 1. **Default (`externalLifecycle: false`) — strict bounded close.**
   *    `close()` waits up to `closeTimeoutMs` for the in-flight
   *    `XREADGROUP BLOCK` to drain. On timeout it calls `redis.disconnect()`
   *    (or `quit()` if the client lacks `disconnect`) to break the BLOCK
   *    immediately, then awaits the loop's exit. After `close()` returns
   *    the transport is fully closed and the connection is released.
   *
   * 2. **`externalLifecycle: true` — bounded RETURN, background drain.**
   *    Arc must NOT touch a connection it doesn't own. `close()` returns
   *    within `closeTimeoutMs`, but the poll loop is left to drain on its
   *    own when its outstanding `XREADGROUP BLOCK` returns (up to
   *    `blockTimeMs`). Arc silently absorbs the loop's eventual completion
   *    so the host doesn't see unhandled rejections / log spam against a
   *    transport it considers closed. The host's own `redis.quit()` /
   *    process exit is what ultimately tears the connection down.
   *
   *    Practical implication: under `externalLifecycle: true`, set
   *    `blockTimeMs` low (e.g. 500ms) so the background drain window is
   *    short. The transport is "closed enough" to stop dispatching to
   *    handlers (handlers map is cleared and generation is bumped) but is
   *    not "fully closed" in the connection-lifecycle sense until the host
   *    closes the underlying client.
   *
   * In both modes the generation counter is bumped, so a follow-up
   * `subscribe()` spawns a fresh poll loop with a new generation — the
   * stale loop exits on its next iteration and never overlaps the new one.
   */
  async close(): Promise<void> {
    this.running = false;
    // Bump generation so any future subscribe() spawns a fresh loop with a
    // new identity, AND the in-flight loop exits on its next iteration even
    // if `running` is racing with a new subscribe().
    this.generation++;
    this.handlers.clear();

    // Two-phase shutdown:
    //   1. Race the in-flight `XREADGROUP BLOCK` against `closeTimeoutMs`.
    //      If the loop drains within the budget, great — clean exit.
    //   2. Otherwise, call `redis.quit()` to break the BLOCK with a
    //      connection error, which the poll loop catches as a normal exit
    //      condition (logged + sets running=false). Bounded shutdown so
    //      tests/serverless don't hang for `blockTimeMs`.
    //
    // `externalLifecycle: true` skips `quit()` — host owns the client and
    // expects to keep it alive across transport teardown.
    if (this.pollPromise) {
      const drained = await Promise.race([
        this.pollPromise.then(() => "drained" as const),
        this.sleep(this.closeTimeoutMs).then(() => "timeout" as const),
      ]);

      if (drained === "timeout") {
        if (!this.externalLifecycle) {
          // Force-break the BLOCK. `quit()` is graceful — it waits for the
          // server to process queued commands, but our queued command IS the
          // BLOCK, so quit() would wait the full blockTimeMs. `disconnect()`
          // tears the socket down immediately, which the BLOCK observes as a
          // network error and the poll loop catches as a normal exit.
          if (typeof this.redis.disconnect === "function") {
            this.redis.disconnect();
          } else {
            // No force path on this client — best-effort graceful quit. Tests
            // / serverless apps pinned to this branch may still hang up to
            // blockTimeMs; document RedisStreamLike.disconnect on your client.
            await this.redis.quit().catch((err) => {
              this.logger.error("[RedisStreamTransport] quit() during close raced:", err);
            });
          }
          await this.pollPromise.catch(() => undefined);
        } else {
          // externalLifecycle: host owns the connection — we MUST NOT close
          // it. The poll loop will drain on its own when XREADGROUP BLOCK
          // returns (up to `blockTimeMs`). Silence its eventual outcome so
          // the host doesn't see an unhandled rejection / log spam against
          // a transport it considers closed. The contract here is "bounded
          // return, background drain" — documented on `closeTimeoutMs`.
          this.pollPromise.catch(() => undefined);
        }
      }
      this.pollPromise = null;
    }

    // Already-drained path: still need to release the connection unless
    // the host owns its lifecycle.
    if (!this.externalLifecycle) {
      await this.redis.quit().catch(() => undefined);
    }
  }

  // -----------------------------------------------------------------------
  // Consumer group management
  // -----------------------------------------------------------------------

  private async ensureGroup(): Promise<void> {
    if (this.groupCreated) return;

    try {
      // Create the consumer group, starting from new messages ('$')
      // Use MKSTREAM to auto-create the stream if it doesn't exist
      await this.redis.xgroup("CREATE", this.stream, this.group, "$", "MKSTREAM");
    } catch (err: unknown) {
      // BUSYGROUP = group already exists, which is fine
      if (err instanceof Error && !err.message.includes("BUSYGROUP")) {
        throw err;
      }
    }

    this.groupCreated = true;
  }

  // -----------------------------------------------------------------------
  // Poll loop — reads new messages + claims pending (crash recovery)
  // -----------------------------------------------------------------------

  private async pollLoop(myGen: number): Promise<void> {
    // Two-condition exit: standard `running` flag AND a generation match.
    // Generation guards against the close → fast-resubscribe race where a
    // new loop spawns while we're still in `XREADGROUP BLOCK`. After that
    // BLOCK returns we'll see the bumped generation and exit cleanly even
    // though `running` is back to true under the NEW loop.
    while (this.running && this.generation === myGen) {
      try {
        // Phase 1: Claim pending entries from dead consumers (crash recovery)
        await this.claimPending();

        // Phase 2: Read new messages
        await this.readNewMessages();
      } catch (err) {
        if (this.running && this.generation === myGen) {
          this.logger.error("[RedisStreamTransport] Poll error:", err);
          // Brief pause before retrying on error
          await this.sleep(1000);
        }
      }
    }
  }

  private async readNewMessages(): Promise<void> {
    // XREADGROUP GROUP <group> <consumer> COUNT <n> BLOCK <ms> STREAMS <key> >
    const result = await this.redis.xreadgroup(
      "GROUP",
      this.group,
      this.consumer,
      "COUNT",
      this.batchSize,
      "BLOCK",
      this.blockTimeMs,
      "STREAMS",
      this.stream,
      ">",
    );

    if (!result) return; // Timeout, no new messages

    for (const [, entries] of result) {
      for (const [messageId, fields] of entries) {
        await this.processEntry(messageId, fields);
      }
    }
  }

  private async claimPending(): Promise<void> {
    try {
      // Check for pending entries across all consumers that have been idle
      const pending = await this.redis.xpending(
        this.stream,
        this.group,
        "-",
        "+",
        10, // Check up to 10 pending entries
      );

      if (!pending || pending.length === 0) return;

      const staleIds: string[] = [];
      const overRetryIds: string[] = [];

      for (const entry of pending) {
        const [id, , idleTime, deliveryCount] = entry;
        if (idleTime > this.claimTimeoutMs) {
          if (deliveryCount >= this.maxRetries) {
            overRetryIds.push(id);
          } else {
            staleIds.push(id);
          }
        }
      }

      // Move over-retry entries to DLQ
      if (overRetryIds.length > 0) {
        await this.moveToDlq(overRetryIds);
      }

      // Claim stale entries
      if (staleIds.length > 0) {
        const claimed = await this.redis.xclaim(
          this.stream,
          this.group,
          this.consumer,
          this.claimTimeoutMs,
          ...staleIds,
        );

        for (const [messageId, fields] of claimed) {
          await this.processEntry(messageId, fields);
        }
      }
    } catch (err) {
      // Pending check failures are non-fatal — will retry next poll iteration.
      // But we MUST log so operators know about Redis connectivity issues,
      // permission errors, or processEntry failures that could cause message loss.
      this.logger.error("[RedisStreamTransport] claimPending error:", err);
    }
  }

  // -----------------------------------------------------------------------
  // Message processing
  // -----------------------------------------------------------------------

  private async processEntry(messageId: string, fields: string[]): Promise<void> {
    const event = parseStreamFields(fields);
    if (!event) {
      this.logger.warn(
        `[RedisStreamTransport] Malformed entry ${messageId} — missing type/data or invalid JSON, acking and skipping`,
      );
      await this.redis.xack(this.stream, this.group, messageId);
      return;
    }

    // Dispatch to matching handlers
    const matchingHandlers = this.getMatchingHandlers(event.type);
    let allSucceeded = true;
    let lastError: Error | undefined;
    let lastHandlerName: string | undefined;

    for (const handler of matchingHandlers) {
      try {
        await handler(event);
      } catch (err) {
        allSucceeded = false;
        lastError = err instanceof Error ? err : new Error(String(err));
        lastHandlerName = (handler as { name?: string }).name || lastHandlerName;
        this.logger.error(`[RedisStreamTransport] Handler error for ${event.type}:`, err);
      }
    }

    if (allSucceeded) {
      await this.redis.xack(this.stream, this.group, messageId);
      // Clear any stale failure context — the message was eventually delivered
      // (likely after a retry on a different consumer) and will not reach DLQ.
      this.failureContext.delete(messageId);
      return;
    }

    // Record the failure so the eventual DLQ write carries the actual error.
    // The pending-claim path in claimPending() keys off message id alone; this
    // map closes the "reclaimed without error context" hole noted in 2.11.3.
    const now = new Date();
    const prior = this.failureContext.get(messageId);
    this.failureContext.set(messageId, {
      error: lastError
        ? toErrorRecord(lastError)
        : { message: "handler returned without acking — no error captured" },
      firstFailedAt: prior?.firstFailedAt ?? now,
      lastFailedAt: now,
      attempts: (prior?.attempts ?? 0) + 1,
      handlerName: lastHandlerName ?? prior?.handlerName,
    });
    // Leave unacked — pending claim picks it up after claimTimeoutMs.
  }

  private getMatchingHandlers(eventType: string): EventHandler[] {
    const matched: EventHandler[] = [];

    for (const [pattern, handlers] of this.handlers) {
      if (this.matchesPattern(pattern, eventType)) {
        for (const h of handlers) {
          matched.push(h);
        }
      }
    }

    return matched;
  }

  private matchesPattern(pattern: string, eventType: string): boolean {
    if (pattern === "*") return true;
    if (pattern === eventType) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return eventType.startsWith(`${prefix}.`);
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Dead letter queue
  // -----------------------------------------------------------------------

  private async moveToDlq(ids: string[]): Promise<void> {
    if (this.deadLetterStream === false) {
      // DLQ disabled — just ack and drop
      for (const id of ids) {
        await this.redis.xack(this.stream, this.group, id);
        this.failureContext.delete(id);
      }
      return;
    }

    // Build a full DeadLetteredEvent envelope per message and persist it
    // to the DLQ stream as `data: <json>`. Critical for replay: pre-2.11.3
    // we wrote only `{ originalStream, originalId, group, failedAt }`,
    // which became unreplayable the moment the source stream's MAXLEN trim
    // dropped the original entry. The envelope now contains the full event
    // payload + the actual handler error (when this consumer saw the
    // failure) + accurate timestamps.
    for (const id of ids) {
      try {
        const envelope = await this.buildDlqEnvelope(id);
        // ⚠️ envelope is null when both `xrange` returned empty AND there
        // was no in-process failure context — the message is gone, log it
        // and ack so we don't keep claiming a ghost.
        if (!envelope) {
          this.logger.error(
            `[RedisStreamTransport] DLQ for ${id}: source entry missing AND no failure context — acking to drop`,
          );
          await this.redis.xack(this.stream, this.group, id);
          this.failureContext.delete(id);
          continue;
        }

        await (this.redis as unknown as RedisStreamLike).xadd(
          this.deadLetterStream,
          "*",
          "type",
          envelope.event.type,
          "originalStream",
          this.stream,
          "originalId",
          id,
          "group",
          this.group,
          "data",
          JSON.stringify(envelope),
        );
        await this.redis.xack(this.stream, this.group, id);
        this.failureContext.delete(id);
      } catch (err) {
        this.logger.error(`[RedisStreamTransport] DLQ write failed for ${id}:`, err);
      }
    }
  }

  /**
   * Reconstruct a `DeadLetteredEvent` for a message id. Reads the original
   * entry via `xrange` (when the client supports it) and merges in any
   * in-process failure context. Returns `null` only when BOTH sources are
   * missing — callers ack-and-drop rather than re-queuing a ghost.
   *
   * Graceful degradation paths:
   *   - Client lacks `xrange` (older custom wrappers) → log once, build the
   *     envelope from `failureContext` alone. Payload is absent but the
   *     error reason + attempt accounting still survive.
   *   - `xrange` throws (network blip, ACL) → same fallback.
   *   - Source entry trimmed before DLQ write → same fallback.
   */
  private async buildDlqEnvelope(id: string): Promise<DeadLetteredEvent | null> {
    const ctx = this.failureContext.get(id);
    let event: DomainEvent | null = null;

    if (typeof this.redis.xrange === "function") {
      try {
        const entries = await this.redis.xrange(this.stream, id, id);
        const fields = entries[0]?.[1];
        if (fields) {
          const parsed = parseStreamFields(fields);
          if (parsed) event = parsed;
        }
      } catch (err) {
        this.logger.error(`[RedisStreamTransport] xrange for DLQ source ${id} failed:`, err);
      }
    } else if (!this.xrangeWarningEmitted) {
      // One-shot warn — repeating on every DLQ entry is noise.
      this.xrangeWarningEmitted = true;
      this.logger.warn(
        "[RedisStreamTransport] Redis client lacks xrange() — DLQ envelopes will not include the original event payload. " +
          "Upgrade your client (ioredis ≥4 supports it) or use a wrapper that proxies xrange to enable replay.",
      );
    }

    // Both gone — message has been trimmed (or xrange unavailable) AND we
    // never observed a failure for it locally (e.g. it failed on a different
    // consumer that crashed). Caller decides what to do; we ack-and-drop.
    if (!event && !ctx) return null;

    const fallbackTime = new Date();
    return {
      event:
        event ??
        ({
          type: "<unknown>",
          payload: null,
          meta: { id, timestamp: fallbackTime },
        } as DomainEvent),
      error: ctx?.error ?? {
        message:
          "exhausted retries — failure occurred on a different consumer; error context not preserved across consumer-group failover",
      },
      attempts: ctx?.attempts ?? this.maxRetries,
      firstFailedAt: ctx?.firstFailedAt ?? fallbackTime,
      lastFailedAt: ctx?.lastFailedAt ?? fallbackTime,
      ...(ctx?.handlerName ? { handlerName: ctx.handlerName } : {}),
    };
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers — pure, no transport state
// ---------------------------------------------------------------------------

/**
 * Convert a thrown value into the `DeadLetteredEvent.error` shape — message
 * always present, optional `code` (string only) and `stack`. Centralised so
 * the failure-context tracker and the DLQ envelope writer agree.
 */
function toErrorRecord(err: unknown): { message: string; code?: string; stack?: string } {
  const e = err instanceof Error ? err : new Error(String(err));
  const code = (e as { code?: unknown }).code;
  return {
    message: e.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(e.stack ? { stack: e.stack } : {}),
  };
}

/**
 * Parse a Redis Stream entry's flat `[key, value, key, value, ...]` field
 * array into a typed `DomainEvent`, or `null` when the entry is malformed
 * (missing `type` / `data`, unparseable JSON, or missing required event
 * structure).
 *
 * Pure on purpose — used by both `processEntry` (the live consumer path)
 * and `buildDlqEnvelope` (the dead-letter writer). Keeping the parse logic
 * in one place avoids the silent drift class that produced the original
 * "DLQ has no payload" bug.
 */
function parseStreamFields(fields: string[]): DomainEvent | null {
  let eventType: string | undefined;
  let rawData: string | undefined;
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key === "type") eventType = value;
    else if (key === "data") rawData = value;
  }
  if (!eventType || !rawData) return null;

  try {
    const parsed = JSON.parse(rawData, (key, value) => {
      // Revive the timestamp written via JSON.stringify in publish().
      if (key === "timestamp" && typeof value === "string") return new Date(value);
      return value;
    });
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.type !== "string" ||
      !parsed.meta?.id
    ) {
      return null;
    }
    return parsed as DomainEvent;
  } catch {
    return null;
  }
}
