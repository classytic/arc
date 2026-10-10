/**
 * Redis Stream Event Transport — durable, at-least-once delivery via
 * `XADD`/`XREADGROUP` consumer groups (one consumer per group gets each event).
 *
 * Failed messages stay unacked and are reclaimed after `claimTimeoutMs`, so
 * handlers may run more than once — they must be idempotent (dedupe on
 * `event.meta.id`). Entries exceeding `maxRetries` move to a dead-letter stream.
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

import { createEventRouter } from "@classytic/primitives/events";
import sjson from "secure-json-parse";
import { evictToSize } from "../../collections/boundedMap.js";
import { runWorkScope, workSeedFromEvent } from "../../context/workScope.js";
import type {
  DeadLetteredEvent,
  DomainEvent,
  EventHandler,
  EventLogger,
  EventTransport,
} from "../EventTransport.js";
import { getSubscriberId } from "../subscriberIdentity.js";

// ---------------------------------------------------------------------------
// Minimal Redis-like interface for Streams support
// ---------------------------------------------------------------------------

export interface RedisStreamLike {
  xadd(key: string, id: string, ...fieldValues: string[]): Promise<string | null>;
  /**
   * Per-handler progress for a partially failed message — which handlers already completed, so
   * a retry (on any replica) runs only the rest. Optional for custom wrappers; without them a
   * retry re-runs every handler and the transport warns once.
   */
  hset?(key: string, ...fieldValues: string[]): Promise<unknown>;
  hgetall?(key: string): Promise<Record<string, string>>;
  del?(...keys: string[]): Promise<unknown>;
  pexpire?(key: string, ms: number): Promise<unknown>;
  // `unknown[]` tails: ioredis types these as overloads over literal tokens
  // plus an optional callback, which a `(string | number)[]` tail can't match.
  xreadgroup(
    command: "GROUP",
    group: string,
    consumer: string,
    ...args: unknown[]
    // `fields` is null for an entry trimmed while pending — the transport acks those.
  ): Promise<Array<[string, Array<[string, string[] | null]>]> | null>;
  xack(key: string, group: string, ...ids: unknown[]): Promise<number>;
  xgroup(command: string, key: string, group: string, ...args: unknown[]): Promise<unknown>;
  xpending(key: string, group: string, ...args: unknown[]): Promise<unknown[]>;
  xclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleTime: number,
    ...ids: unknown[]
  ): Promise<unknown[]>;
  xlen(key: string): Promise<number>;
  /**
   * Lets the DLQ writer copy the original payload into the envelope, making
   * dead-lettered events replayable. Without it the envelope keeps the error
   * and attempt count but `event.payload` is `null` (warned once per process).
   */
  xrange?(key: string, start: string, end: string): Promise<Array<[string, string[]]>>;
  /** Graceful close — flushes queued commands then closes. ioredis-style. */
  quit(): Promise<unknown>;
  /**
   * Force-disconnect, abandoning a live `XREADGROUP BLOCK`. When missing,
   * `close()` falls back to `quit()` and may wait up to `blockTimeMs`.
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
   * How long a partially failed message's per-handler progress is kept, in ms. Must outlast the
   * retry window. @default 7 days
   */
  handlerProgressTtlMs?: number;

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
   * Max entries of a batch processed concurrently. `1` keeps strict stream
   * order; higher values let entries complete OUT OF ORDER, so raise it only
   * for order-independent handlers. Handlers for a single event always run
   * sequentially.
   * @default 1
   */
  processingConcurrency?: number;

  /**
   * Max delivery attempts before moving to dead letter stream.
   * @default 5
   */
  maxRetries?: number;

  /**
   * Idle time in ms before another consumer may claim a pending entry
   * (crash recovery).
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
   * Max stream length (approximate, XADD MAXLEN ~). Trimming can drop entries still PENDING for a
   * slow consumer, so it is opt-in: set it only with lag / oldest-pending monitoring in place.
   * @default 0 (no trimming)
   */
  maxLen?: number;

  /**
   * Where a NEW consumer group starts reading. `'latest'` (`$`) skips entries published before the
   * group existed; `'beginning'` (`0`) replays the whole stream — including every side effect.
   * @default 'latest'
   */
  groupStart?: "latest" | "beginning";

  /**
   * Max serialized event size in bytes; `publish()` rejects larger events.
   * @default 1_000_000 (1 MB)
   */
  maxPayloadBytes?: number;

  /**
   * If `true`, `close()` never quits/disconnects the client — for a Redis
   * connection shared with other transports or stores.
   * @default false
   */
  externalLifecycle?: boolean;

  /**
   * Max time `close()` waits for the in-flight `XREADGROUP BLOCK` to drain.
   * On timeout the client is force-disconnected, or — under
   * `externalLifecycle` — the loop drains in the background (see `close()`).
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

/**
 * Cap on the failure-context map: a message that fails here but is resolved by
 * ANOTHER consumer is never cleared locally. Eviction is oldest-first and only
 * degrades the DLQ envelope's error detail, never loses the event.
 */
const MAX_FAILURE_CONTEXT_ENTRIES = 1024;

export class RedisStreamTransport implements EventTransport {
  readonly name = "redis-stream";

  private redis: RedisStreamLike;
  private stream: string;
  private group: string;
  private consumer: string;
  private blockTimeMs: number;
  private batchSize: number;
  private processingConcurrency: number;
  private maxRetries: number;
  private claimTimeoutMs: number;
  private deadLetterStream: string | false;
  private maxLen: number;
  private groupStartId: "0" | "$";
  private maxPayloadBytes: number;

  private logger: EventLogger;

  private externalLifecycle: boolean;
  private closeTimeoutMs: number;

  private router = createEventRouter<EventHandler>();
  private running = false;
  private pollPromise: Promise<void> | null = null;
  /**
   * Bumped whenever the poll loop should stop (last unsubscribe, `close()`).
   * Each loop exits once its captured generation is stale, so a fast
   * unsubscribe → resubscribe never leaves two loops on one consumer name.
   */
  private generation = 0;
  private groupCreated = false;

  /**
   * Last handler failure per message id, so the DLQ envelope carries the real
   * error. Cleared on ack / DLQ write; capped at {@link MAX_FAILURE_CONTEXT_ENTRIES}.
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

  /** Set by `hold()`: subscriptions register, consumption waits for `start()`. */
  private held = false;

  /** Handler → a key stable across replicas: pattern, name, and order among same-named handlers. */
  private handlerKeys = new Map<EventHandler, string>();
  private handlerKeyOwners = new Map<string, EventHandler>();
  private handlerPatterns = new Map<EventHandler, Set<string>>();
  private handlerProgressTtlMs: number;
  private readonly tracksProgress: boolean;

  private xrangeWarningEmitted = false;

  constructor(redis: RedisStreamLike, options: RedisStreamTransportOptions = {}) {
    this.redis = redis;
    this.stream = options.stream ?? "arc:events";
    this.group = options.group ?? "default";
    this.consumer = options.consumer ?? `consumer-${crypto.randomUUID().slice(0, 8)}`;
    this.blockTimeMs = options.blockTimeMs ?? 5000;
    this.batchSize = options.batchSize ?? 10;
    this.processingConcurrency = Math.max(1, Math.floor(options.processingConcurrency ?? 1));
    this.maxRetries = options.maxRetries ?? 5;
    this.claimTimeoutMs = options.claimTimeoutMs ?? 30_000;
    this.deadLetterStream = options.deadLetterStream ?? "arc:events:dlq";
    this.maxLen = options.maxLen ?? 0;
    this.groupStartId = options.groupStart === "beginning" ? "0" : "$";
    this.maxPayloadBytes = options.maxPayloadBytes ?? 1_000_000;
    this.externalLifecycle = options.externalLifecycle ?? false;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 1000;
    this.logger = options.logger ?? console;
    this.handlerProgressTtlMs = options.handlerProgressTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.tracksProgress = ["hset", "hgetall", "del", "pexpire"].every(
      (m) => typeof (redis as unknown as Record<string, unknown>)[m] === "function",
    );
    if (!this.tracksProgress) {
      this.logger.warn(
        "[RedisStreamTransport] redis client lacks hset/hgetall/del/pexpire — a retried message re-runs handlers that already succeeded. Use ioredis or add them to the wrapper.",
      );
    }
  }

  // -----------------------------------------------------------------------
  // EventTransport.publish
  // -----------------------------------------------------------------------

  async publish(event: DomainEvent): Promise<void> {
    const serialized = JSON.stringify(event);

    const payloadBytes = Buffer.byteLength(serialized, "utf8");
    if (payloadBytes > this.maxPayloadBytes) {
      throw new Error(
        `[RedisStreamTransport] Event payload (${payloadBytes} bytes) exceeds limit (${this.maxPayloadBytes}). ` +
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

    // ioredis overloads `xadd` heavily; narrow to one variadic signature.
    type XaddCallable = (...args: (string | number)[]) => Promise<string | null>;
    await (this.redis as { xadd: XaddCallable }).xadd(...args);
  }

  // -----------------------------------------------------------------------
  // EventTransport.subscribe
  // -----------------------------------------------------------------------

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlerKeys.has(handler)) {
      const id = getSubscriberId(handler);
      const key =
        id === undefined ? `${pattern}#${handler.name || "anonymous"}` : `subscriber:${id}`;
      const owner = this.handlerKeyOwners.get(key);
      if (owner && owner !== handler) {
        throw new Error(
          `[RedisStreamTransport] Ambiguous subscriber identity '${key}' — wrap each handler withSubscriberId using a stable unique id.`,
        );
      }
      this.handlerKeyOwners.set(key, handler);
      this.handlerKeys.set(handler, key);
    }
    const patterns = this.handlerPatterns.get(handler) ?? new Set<string>();
    patterns.add(pattern);
    this.handlerPatterns.set(handler, patterns);
    this.router.add(pattern, handler);
    if (!this.held) await this.startPolling();

    return () => {
      this.router.remove(pattern, handler);
      patterns.delete(pattern);
      if (patterns.size === 0) {
        const key = this.handlerKeys.get(handler);
        if (key && this.handlerKeyOwners.get(key) === handler) this.handlerKeyOwners.delete(key);
        this.handlerKeys.delete(handler);
        this.handlerPatterns.delete(handler);
      }
      // No handlers left: stop polling; the generation bump ends the in-flight loop.
      if (this.router.size === 0 && this.running) {
        this.running = false;
        this.generation++;
      }
    };
  }

  /**
   * Register subscriptions without consuming until `start()`. arc holds consumption for the whole
   * boot, so an entry for a module whose handler installs later is not acked with no handler.
   */
  hold(): void {
    this.held = true;
  }

  /** Begin consuming — every handler registered while held sees the stream from here. */
  async start(): Promise<void> {
    this.held = false;
    if (this.router.size > 0) await this.startPolling();
  }

  // A prior loop from a subscribe → unsubscribe cycle may still be draining its last
  // `XREADGROUP BLOCK`; bumping the generation makes it exit instead of running alongside.
  private async startPolling(): Promise<void> {
    if (this.running) return;
    await this.ensureGroup();
    this.running = true;
    const myGen = ++this.generation;
    this.pollPromise = this.pollLoop(myGen).catch((err) => {
      this.logger.error("[RedisStreamTransport] Poll loop crashed:", err);
      // A newer loop may have started after a crash — do not trample its state.
      if (this.generation === myGen) this.running = false;
    });
  }

  // -----------------------------------------------------------------------
  // EventTransport.close
  // -----------------------------------------------------------------------

  /**
   * Stop polling and release transport state. Waits up to `closeTimeoutMs`
   * for the in-flight `XREADGROUP BLOCK`, then:
   *
   * - default: force-disconnects the client to break the BLOCK and awaits the
   *   loop — the transport is fully closed on return.
   * - `externalLifecycle: true`: returns without touching the host's client;
   *   the loop drains in the background (up to `blockTimeMs` — keep it low)
   *   with its outcome silenced. Handlers are already cleared, so nothing
   *   dispatches meanwhile.
   *
   * A later `subscribe()` starts a fresh loop that never overlaps the stale one.
   */
  async close(): Promise<void> {
    this.running = false;
    this.generation++;
    this.router.clear();
    this.failureContext.clear();
    this.handlerKeys.clear();
    this.handlerKeyOwners.clear();
    this.handlerPatterns.clear();

    if (this.pollPromise !== null) {
      const drained = await Promise.race([
        this.pollPromise.then(() => "drained" as const),
        this.sleep(this.closeTimeoutMs).then(() => "timeout" as const),
      ]);

      if (drained === "timeout") {
        if (!this.externalLifecycle) {
          // Not `quit()`: it waits for queued commands, and the queued command
          // IS the BLOCK. `disconnect()` breaks it immediately.
          if (typeof this.redis.disconnect === "function") {
            this.redis.disconnect();
          } else {
            await this.redis.quit().catch((err) => {
              this.logger.error("[RedisStreamTransport] quit() during close raced:", err);
            });
          }
          await this.pollPromise.catch(() => undefined);
        } else {
          // Host owns the connection: let the loop drain, silence its outcome.
          this.pollPromise.catch(() => undefined);
        }
      }
      this.pollPromise = null;
    }

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
      await this.redis.xgroup("CREATE", this.stream, this.group, this.groupStartId, "MKSTREAM");
    } catch (err: unknown) {
      // BUSYGROUP = group already exists.
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
    // The generation check matters when `running` is true again under a NEW loop.
    let pollErrorAttempts = 0;
    while (this.running && this.generation === myGen) {
      try {
        // Reclaim entries from dead consumers first, then read new ones.
        await this.claimPending();

        await this.readNewMessages();

        pollErrorAttempts = 0;
      } catch (err) {
        if (this.running && this.generation === myGen) {
          pollErrorAttempts++;
          this.logger.error("[RedisStreamTransport] Poll error:", err);
          // Jittered so consumers that saw the same Redis blip don't retry in lockstep.
          await this.sleep(fullJitterBackoffMs(pollErrorAttempts));
        }
      }
    }
  }

  private async readNewMessages(): Promise<void> {
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

    if (!result) return; // BLOCK timed out

    for (const [, entries] of result) {
      await this.processEntries(entries);
    }
  }

  /** Process a batch with at most `processingConcurrency` entries in flight. */
  private async processEntries(
    entries: Array<[string, string[] | null]>,
    retry = false,
  ): Promise<void> {
    // A field-less entry was trimmed after delivery. Acking is the only way to
    // clear it from the pending list; otherwise every claim cycle re-delivers it.
    const live: Array<[string, string[]]> = [];
    const ghostIds: string[] = [];
    for (const [messageId, fields] of entries) {
      if (fields) live.push([messageId, fields]);
      else ghostIds.push(messageId);
    }
    if (ghostIds.length > 0) {
      // One variadic XACK. A failure must not take the live entries down —
      // the ghosts stay pending and the next claim cycle retries the ack.
      try {
        await this.redis.xack(this.stream, this.group, ...ghostIds);
      } catch (err) {
        this.logger.error(
          `[RedisStreamTransport] Failed to ack ${ghostIds.length} trimmed entr(ies):`,
          err,
        );
      }
    }

    if (this.processingConcurrency <= 1) {
      for (const [messageId, fields] of live) {
        await this.processEntry(messageId, fields, retry);
      }
      return;
    }
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.processingConcurrency, live.length) },
      async () => {
        while (next < live.length) {
          const entry = live[next++];
          if (entry) await this.processEntry(entry[0], entry[1], retry);
        }
      },
    );
    await Promise.all(workers);
  }

  private async claimPending(): Promise<void> {
    try {
      // Window scales with batchSize so crash recovery keeps pace with reads.
      const pending = await this.redis.xpending(
        this.stream,
        this.group,
        "-",
        "+",
        Math.max(this.batchSize, 10),
      );

      if (!pending || pending.length === 0) return;

      const staleIds: string[] = [];
      const overRetryIds: string[] = [];

      // XPENDING extended form: [id, consumer, idleMs, deliveryCount] per row.
      for (const entry of pending as Array<[string, string, number, number]>) {
        const [id, , idleTime, deliveryCount] = entry;
        if (idleTime > this.claimTimeoutMs) {
          if (deliveryCount >= this.maxRetries) {
            overRetryIds.push(id);
          } else {
            staleIds.push(id);
          }
        }
      }

      if (overRetryIds.length > 0) {
        await this.moveToDlq(overRetryIds);
      }

      if (staleIds.length > 0) {
        const claimed = await this.redis.xclaim(
          this.stream,
          this.group,
          this.consumer,
          this.claimTimeoutMs,
          ...staleIds,
        );

        // XCLAIM reply: [id, fields | null] per entry (null once trimmed).
        await this.processEntries(claimed as Array<[string, string[] | null]>, true);
      }
    } catch (err) {
      // Non-fatal (retried next poll), but logged — it can hide stuck messages.
      this.logger.error("[RedisStreamTransport] claimPending error:", err);
    }
  }

  // -----------------------------------------------------------------------
  // Message processing
  // -----------------------------------------------------------------------

  private async processEntry(messageId: string, fields: string[], retry = false): Promise<void> {
    const event = parseStreamFields(fields);
    if (!event) {
      this.logger.warn(
        `[RedisStreamTransport] Malformed entry ${messageId} — missing type/data or invalid JSON, acking and skipping`,
      );
      await this.redis.xack(this.stream, this.group, messageId);
      return;
    }

    const matchingHandlers = this.getMatchingHandlers(event.type);
    // A retry runs only the handlers that have not completed this message (on any replica).
    const progressKey = `${this.stream}:handled:${this.group}:${messageId}`;
    const alreadyDone =
      retry && this.tracksProgress
        ? new Set(Object.keys((await this.redis.hgetall?.(progressKey)) ?? {}))
        : new Set<string>();
    const completed: string[] = [];
    let allSucceeded = true;
    let lastError: Error | undefined;
    let lastHandlerName: string | undefined;

    // One work scope per entry: handlers share a per-event cache and correlation id.
    await runWorkScope(workSeedFromEvent(event), async () => {
      for (const handler of matchingHandlers) {
        const key = this.handlerKeys.get(handler) ?? handler.name;
        if (alreadyDone.has(key)) continue;
        try {
          await handler(event);
          completed.push(key);
        } catch (err) {
          allSucceeded = false;
          lastError = err instanceof Error ? err : new Error(String(err));
          lastHandlerName = (handler as { name?: string }).name || lastHandlerName;
          this.logger.error(`[RedisStreamTransport] Handler error for ${event.type}:`, err);
        }
      }
    });

    if (allSucceeded) {
      await this.redis.xack(this.stream, this.group, messageId);
      if (alreadyDone.size > 0) await this.redis.del?.(progressKey);
      this.failureContext.delete(messageId);
      return;
    }

    if (this.tracksProgress && completed.length > 0) {
      await this.redis.hset?.(progressKey, ...completed.flatMap((k) => [k, "1"]));
      await this.redis.pexpire?.(progressKey, this.handlerProgressTtlMs);
    }

    const now = new Date();
    const prior = this.failureContext.get(messageId);
    // delete-then-set moves the id to the Map's tail, so eviction takes the stalest entry.
    this.failureContext.delete(messageId);
    this.failureContext.set(messageId, {
      error: lastError
        ? toErrorRecord(lastError)
        : { message: "handler returned without acking — no error captured" },
      firstFailedAt: prior?.firstFailedAt ?? now,
      lastFailedAt: now,
      attempts: (prior?.attempts ?? 0) + 1,
      handlerName: lastHandlerName ?? prior?.handlerName,
    });
    evictToSize(this.failureContext, MAX_FAILURE_CONTEXT_ENTRIES);
    // Leave unacked — pending claim picks it up after claimTimeoutMs.
  }

  /**
   * Uses the primitives router — the same glob rules (and dedup) as the memory
   * transport. Don't swap in a private matcher: subscriptions must behave
   * identically in-process and on the stream.
   */
  private getMatchingHandlers(eventType: string): readonly EventHandler[] {
    return this.router.route(eventType);
  }

  // -----------------------------------------------------------------------
  // Dead letter queue
  // -----------------------------------------------------------------------

  private async moveToDlq(ids: string[]): Promise<void> {
    if (this.deadLetterStream === false) {
      for (const id of ids) {
        await this.redis.xack(this.stream, this.group, id);
        this.failureContext.delete(id);
      }
      return;
    }

    // The DLQ entry carries the FULL event, not a pointer into the source
    // stream — a MAXLEN trim would otherwise make it unreplayable.
    for (const id of ids) {
      try {
        const envelope = await this.buildDlqEnvelope(id);
        // Neither the entry nor any failure context survives — ack so we stop reclaiming it.
        if (!envelope) {
          this.logger.error(
            `[RedisStreamTransport] DLQ for ${id}: source entry missing AND no failure context — acking to drop`,
          );
          await this.redis.xack(this.stream, this.group, id);
          this.failureContext.delete(id);
          continue;
        }

        await (this.redis as RedisStreamLike).xadd(
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
   * Build a `DeadLetteredEvent` from the original entry (via `xrange`) plus
   * any local failure context. If the entry is unreadable (no `xrange`, error,
   * or trimmed) the envelope keeps just the error and attempts. Returns `null`
   * only when both are missing.
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
      this.xrangeWarningEmitted = true;
      this.logger.warn(
        "[RedisStreamTransport] Redis client lacks xrange() — DLQ envelopes will not include the original event payload. " +
          "Upgrade your client (ioredis ≥4 supports it) or use a wrapper that proxies xrange to enable replay.",
      );
    }

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

const POLL_ERROR_BACKOFF_BASE_MS = 1000;
const POLL_ERROR_BACKOFF_MAX_MS = 30_000;
const POLL_ERROR_BACKOFF_FLOOR_MS = 100;

/**
 * Poll-error delay drawn uniformly from `[floor, min(max, base * 2^(attempt-1))]`
 * ("full jitter"). The floor stops a near-zero draw from hot-spinning while
 * Redis is down. Intentionally separate from the public `exponentialBackoff()`
 * (different jitter model and audience).
 *
 * @param attempt 1-indexed consecutive poll-error count (reset on success)
 * @param random injectable for deterministic tests; defaults to `Math.random`
 */
function fullJitterBackoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = POLL_ERROR_BACKOFF_BASE_MS * 2 ** (Math.max(1, Math.floor(attempt)) - 1);
  const capped = Math.min(POLL_ERROR_BACKOFF_MAX_MS, exp);
  return POLL_ERROR_BACKOFF_FLOOR_MS + random() * (capped - POLL_ERROR_BACKOFF_FLOOR_MS);
}

/** Convert a thrown value into the `DeadLetteredEvent.error` shape. */
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
 * Parse a stream entry's flat `[key, value, ...]` fields into a `DomainEvent`,
 * or `null` when malformed. Shared by the consumer and the DLQ writer so the
 * two can't drift.
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
    // Cross-service trust boundary: sjson blocks `__proto__` / `constructor.prototype`
    // keys so a poisoned entry can't pollute the consumer's Object prototype.
    const parsed = sjson.parse(rawData, (key, value) => {
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
