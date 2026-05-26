/**
 * Per-connection dead queue — ring buffer holding the last N outbound
 * critical messages so a reconnecting client can RESUME and have any
 * messages missed during the disconnect replayed in order.
 *
 * Modelled on Mattermost's `deadQueueSize = 128` ring (web_conn.go). Only
 * `send()`-class (critical, ordered) frames go in; `sendRealtime()` frames
 * are by definition droppable so replaying them on resume gives the user
 * a stale snapshot — better to wait for the next live update.
 *
 * Each entry carries the monotonic sequence number assigned by the
 * envelope wrapper. Resume semantics:
 *
 *   client → { type: 'resume', lastSeq: N, pushRef: '...' }
 *   server →   if (N+1 is still in the ring): replay (N+1..tail)
 *              else:                          { type: 'resume_gap' }
 *
 * The gap response forces the host to do a fresh sync — losing 128+
 * messages mid-disconnect is rare enough that a re-fetch is acceptable
 * UX; trying to "patch over" a lost message silently is the bad path.
 */

export interface DeadQueueEntry {
  seq: number;
  /** Already-serialized envelope JSON ready to write to the socket. */
  payload: string;
}

/** Default ring size — matches Mattermost's deadQueueSize. */
export const DEFAULT_DEAD_QUEUE_SIZE = 128;

export class DeadQueue {
  private buffer: (DeadQueueEntry | undefined)[];
  private head = 0; // next write index
  private count = 0;
  private capacity: number;

  constructor(capacity = DEFAULT_DEAD_QUEUE_SIZE) {
    this.capacity = capacity;
    this.buffer = new Array<DeadQueueEntry | undefined>(capacity);
  }

  push(entry: DeadQueueEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /**
   * Return entries with seq strictly greater than `lastSeq`, in order,
   * OR `null` if the gap is too large (entry with seq = lastSeq + 1 has
   * already been evicted from the ring — caller should signal `resume_gap`).
   */
  drainAfter(lastSeq: number): DeadQueueEntry[] | null {
    if (this.count === 0) return [];
    const tail = (this.head - this.count + this.capacity) % this.capacity;
    const oldest = this.buffer[tail];
    if (!oldest) return [];
    // If the next expected seq is already gone from the ring, signal gap.
    if (oldest.seq > lastSeq + 1) return null;
    const out: DeadQueueEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (tail + i) % this.capacity;
      const e = this.buffer[idx];
      if (e && e.seq > lastSeq) out.push(e);
    }
    return out;
  }

  size(): number {
    return this.count;
  }

  /** Highest seq currently in the ring (or 0 if empty). */
  highestSeq(): number {
    if (this.count === 0) return 0;
    const lastIdx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[lastIdx]?.seq ?? 0;
  }

  clear(): void {
    this.buffer = new Array<DeadQueueEntry | undefined>(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  /**
   * Return all entries in chronological order. Used by the registry's
   * `persist()` to flush the live ring to the external store. Allocates
   * a fresh array — caller owns it (mutations don't affect the ring).
   */
  snapshot(): DeadQueueEntry[] {
    if (this.count === 0) return [];
    const tail = (this.head - this.count + this.capacity) % this.capacity;
    const out: DeadQueueEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (tail + i) % this.capacity;
      const e = this.buffer[idx];
      if (e) out.push(e);
    }
    return out;
  }
}
