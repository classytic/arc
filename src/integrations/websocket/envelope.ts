/**
 * Sequence-numbered message envelope (opt-in via `messageEnvelope: 'seq'`).
 *
 * Every server→client `send()` (critical, ordered) message is wrapped:
 *
 *   { seq: 42, t: 1234567890, msg: { type: 'ride.accepted', ... } }
 *
 * The client tracks the highest `seq` it has processed. On reconnect it
 * sends `{ type: 'resume', lastSeq: 42, pushRef: 'tab-X' }`; the server
 * replays from the dead queue or responds with `resume_gap` if the gap
 * is bigger than the ring.
 *
 * `sendRealtime()` frames are **not** wrapped — by contract they're
 * droppable and coalesceable, and adding a seq would imply ordering
 * guarantees the contract doesn't make.
 */

import type { DeadQueue, DeadQueueEntry } from "./dead-queue.js";

export interface SeqEnvelope {
  /** Monotonic per-connection sequence number. Starts at 1. */
  seq: number;
  /** Server timestamp (ms since epoch). */
  t: number;
  /** Original message payload (already an object). */
  msg: unknown;
}

/**
 * Per-pushRef envelope state. One instance per logical session — when
 * a client reconnects under the same pushRef within TTL, the same
 * EnvelopeWriter is rehydrated so its `nextSeq` counter and dead queue
 * round-trip across reconnects.
 *
 * The constructor accepts `{ nextSeq }` for the rehydration path —
 * `PushRefRegistry.hydrateEnvelope` passes the persisted counter so
 * the next wrap() picks up where the previous socket left off (no
 * seq collisions, no replay gaps).
 */
export class EnvelopeWriter {
  private nextSeq: number;
  private dead: DeadQueue;

  constructor(deadQueue: DeadQueue, opts: { nextSeq?: number } = {}) {
    this.dead = deadQueue;
    this.nextSeq = opts.nextSeq ?? 1;
  }

  /**
   * Wrap a payload, assign next seq, persist to dead queue. Returns the
   * JSON-stringified envelope ready for the socket.
   */
  wrap(payload: unknown): string {
    const seq = this.nextSeq++;
    const envelope: SeqEnvelope = { seq, t: Date.now(), msg: payload };
    const serialized = JSON.stringify(envelope);
    this.dead.push({ seq, payload: serialized });
    return serialized;
  }

  /**
   * Replay entries strictly greater than `lastSeq`. Returns either the
   * array of payloads to write, OR `null` if the gap is unrecoverable
   * (caller emits `resume_gap`).
   */
  drainAfter(lastSeq: number): string[] | null {
    const entries = this.dead.drainAfter(lastSeq);
    if (entries === null) return null;
    return entries.map((e) => e.payload);
  }

  highestSeq(): number {
    return this.dead.highestSeq();
  }

  /** Peek the next sequence to be assigned (without consuming). */
  peekNextSeq(): number {
    return this.nextSeq;
  }

  /** Snapshot the dead queue contents for persistence. */
  snapshotDeadQueue(): DeadQueueEntry[] {
    return this.dead.snapshot();
  }
}
