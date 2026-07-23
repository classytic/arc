/**
 * Per-connection outbound send queue with two-class delivery semantics.
 *
 * Two send methods, two policies — modelled on Google GenAI's `Live.send`
 * vs `Live.sendRealtime` split and Mattermost's selective-drop (vs Centrifuge's
 * disconnect-on-overflow) overflow strategy.
 *
 *   - **send()** — ordered, queued, important. Backpressure ⇒ the queue
 *     fills; once it overflows the connection is force-terminated so the
 *     client reconnects through a known-broken state instead of silently
 *     losing critical messages mid-stream.
 *
 *   - **sendRealtime()** — fire-and-forget, droppable, coalesce-by-key.
 *     Backpressure ⇒ messages with the same `coalesceKey` replace older
 *     queued entries (keep-latest-snapshot — GPS frames, cursors, presence).
 *     With no coalesce key, the oldest droppable entry is shed.
 *
 * Why two methods, not one method with a `class` field: making the call
 * site different prevents "I added priority=high to fix a bug" drift.
 * `send()` and `sendRealtime()` are clearly distinct contracts.
 *
 * The queue is drained against `socket.bufferedAmount` — entries are
 * popped and written until the socket's outbound buffer crosses a
 * back-pressure threshold, at which point the queue waits for the next
 * `flush()` tick (typically a `setImmediate` after the previous send or
 * an explicit poll from the heartbeat loop).
 */

/** Soft cap — entries beyond this either coalesce, drop, or terminate. */
export const DEFAULT_QUEUE_CAPACITY = 256;

/** Socket buffer threshold — pause draining when bufferedAmount exceeds. */
export const DEFAULT_DRAIN_THRESHOLD = 256 * 1024; // 256 KB — matches room-manager.

/**
 * Delay between auto-flush retries when backpressure pauses draining.
 * Short enough to feel responsive (≤1 frame at 60fps), long enough to
 * avoid burning CPU when the socket is genuinely stuck.
 */
export const DEFAULT_RETRY_DELAY_MS = 50;

type EntryClass = "critical" | "droppable";

interface QueueEntry {
  payload: string;
  cls: EntryClass;
  /**
   * Replacement key for `droppable` entries. Two droppable entries with
   * the same `coalesceKey` collapse to the newer one (keep-latest-snapshot).
   */
  coalesceKey?: string;
}

interface SendQueueSocket {
  send(data: string): void;
  readyState: number;
  bufferedAmount?: number;
  terminate?(): void;
  close?(code?: number, reason?: string): void;
}

export interface SendQueueOptions {
  capacity?: number;
  drainThreshold?: number;
  /** Auto-flush retry delay in ms when backpressure pauses draining. */
  retryDelayMs?: number;
}

/**
 * Per-socket bounded queue. Construct one per accepted connection;
 * `dispose()` on socket close to drop refs.
 */
export class SendQueue {
  private entries: QueueEntry[] = [];
  /**
   * Logical queue head — `entries[head..]` is the live queue. Draining
   * advances the pointer instead of `shift()`ing (which moves every
   * trailing element AND invalidated every tracked coalesce index,
   * making a full drain O(n²)). The prefix is garbage-collected by
   * {@link compactIfNeeded} — amortized O(1) per drained frame.
   */
  private head = 0;
  /** `coalesceKey → ABSOLUTE entries[] index` for O(1) replacement. */
  private coalesceIndex = new Map<string, number>();
  private socket: SendQueueSocket;
  private capacity: number;
  private drainThreshold: number;
  private retryDelayMs: number;
  /** One-shot retry timer set while waiting for backpressure to clear. */
  private retryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(socket: SendQueueSocket, opts: SendQueueOptions = {}) {
    this.socket = socket;
    this.capacity = opts.capacity ?? DEFAULT_QUEUE_CAPACITY;
    this.drainThreshold = opts.drainThreshold ?? DEFAULT_DRAIN_THRESHOLD;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /** Ordered, guaranteed-best-effort delivery. Overflow ⇒ terminate. */
  send(payload: string): void {
    if (this.disposed) return;
    if (this.size() >= this.capacity) {
      // Queue is full of critical (or non-coalescable droppable) frames.
      // Force a reconnect so the client recovers via RESUME (PR 3) rather
      // than silently dropping a payment-confirmed-style message.
      this.terminate("Queue overflow");
      return;
    }
    this.entries.push({ payload, cls: "critical" });
    this.flush();
  }

  /**
   * Fire-and-forget, droppable. With `coalesceKey`, older entry for the
   * same key is replaced in place (preserves queue order, keeps latest
   * payload). Without a key, oldest droppable entry is shed on overflow.
   */
  sendRealtime(payload: string, coalesceKey?: string): void {
    if (this.disposed) return;
    // Coalesce path — replace in-place, no growth. Indices are absolute;
    // one still >= head is live.
    if (coalesceKey !== undefined) {
      const idx = this.coalesceIndex.get(coalesceKey);
      if (idx !== undefined && idx >= this.head && this.entries[idx]) {
        this.entries[idx] = { payload, cls: "droppable", coalesceKey };
        this.flush();
        return;
      }
    }
    if (this.size() >= this.capacity) {
      // Shed the oldest droppable. If everything is critical the new
      // droppable frame is simply dropped (location updates aren't worth
      // killing the connection over). The splice is the rare overflow
      // path — adjust the (small) coalesce map instead of rebuilding.
      let shedIdx = -1;
      for (let i = this.head; i < this.entries.length; i++) {
        if (this.entries[i]?.cls === "droppable") {
          shedIdx = i;
          break;
        }
      }
      if (shedIdx === -1) return;
      const evicted = this.entries.splice(shedIdx, 1)[0];
      if (evicted?.coalesceKey !== undefined) {
        this.coalesceIndex.delete(evicted.coalesceKey);
      }
      for (const [key, idx] of this.coalesceIndex) {
        if (idx > shedIdx) this.coalesceIndex.set(key, idx - 1);
      }
    }
    this.entries.push({ payload, cls: "droppable", coalesceKey });
    if (coalesceKey !== undefined) {
      this.coalesceIndex.set(coalesceKey, this.entries.length - 1);
    }
    this.flush();
  }

  /**
   * Drain entries to the socket until either the queue empties or the
   * socket's outbound buffer crosses the drain threshold. Idempotent —
   * also runs on a self-scheduled retry timer when backpressure pauses
   * draining (so callers never need to manually re-prod the queue).
   */
  flush(): void {
    if (this.disposed) return;
    while (this.size() > 0 && this.socket.readyState === 1) {
      if ((this.socket.bufferedAmount ?? 0) >= this.drainThreshold) {
        // Backpressure — schedule a retry so the queue resumes draining
        // automatically once the socket's buffer drains below threshold.
        // Without this, queued frames would stall indefinitely after the
        // first time the socket goes into backpressure. `break` (not
        // `return`) so the drained prefix is still compacted below — a
        // long backpressure pause must not pin already-sent frames.
        this.scheduleRetry();
        break;
      }
      // Advance the head pointer — no element movement, no index rebuild.
      // Absolute coalesce indices stay valid for every remaining entry.
      const entry = this.entries[this.head];
      if (!entry) return;
      this.head++;
      if (entry.coalesceKey !== undefined) {
        this.coalesceIndex.delete(entry.coalesceKey);
      }
      try {
        this.socket.send(entry.payload);
      } catch {
        // Underlying socket already dead — stop draining; the
        // connection-lifecycle handler will dispose us shortly.
        return;
      }
    }
    this.compactIfNeeded();
  }

  size(): number {
    return this.entries.length - this.head;
  }

  /**
   * Drop the drained prefix once it dominates the array. Rebuilding the
   * (small) coalesce index here is the amortized cost that replaces the
   * per-frame O(n) reindex the old `shift()` drain paid.
   */
  private compactIfNeeded(): void {
    if (this.head < 64 || this.head * 2 < this.entries.length) return;
    this.entries = this.entries.slice(this.head);
    this.head = 0;
    if (this.coalesceIndex.size > 0) {
      this.coalesceIndex.clear();
      this.reindexCoalesceFrom(0);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.entries.length = 0;
    this.head = 0;
    this.coalesceIndex.clear();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /**
   * One-shot retry timer. Called when `flush()` hits backpressure and
   * leaves entries queued — without this, queued frames would stall
   * indefinitely after the socket's buffer drains, because nothing
   * else prods the queue. The timer self-clears on each fire so a
   * single delay is the worst case between drain and resume.
   */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.flush();
    }, this.retryDelayMs);
    // Unref so a stalled queue doesn't hold the event loop open. Test
    // environments may want this behavior too — it's harmless when the
    // process has other work pending.
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private terminate(reason: string): void {
    this.dispose();
    if (typeof this.socket.terminate === "function") {
      this.socket.terminate();
    } else if (typeof this.socket.close === "function") {
      this.socket.close(1011, reason);
    }
  }

  /** Rebuild the coalesce index from `start` onward after a splice/shift. */
  private reindexCoalesceFrom(start: number): void {
    // For small N (≤256) the simple full rebuild from start outperforms
    // tracking deltas. Most droppable streams have ≤10 distinct keys.
    for (let i = start; i < this.entries.length; i++) {
      const k = this.entries[i]?.coalesceKey;
      if (k !== undefined) this.coalesceIndex.set(k, i);
    }
  }
}
