/**
 * PushRef registry — owns the cross-connection state that has to outlive
 * a single TCP socket: the per-pushRef envelope writer + dead queue
 * (PR 3), and the principal binding that prevents another authenticated
 * user from hijacking a pushRef.
 *
 * Single-instance default: state lives in an in-memory `Map`. Same
 * shape as the original single-class registry — but the public surface
 * is **async** so a Redis-backed store can plug in without touching
 * connection.ts.
 *
 * Cross-instance: pass a `PushRefStore` (e.g. the Redis-backed one
 * from `@classytic/arc/integrations/websocket-pushref-redis`). The
 * envelope + principal binding then survive node-to-node reconnects —
 * a client originating on Node A and reconnecting to Node B picks up
 * the same dead queue and replays missed envelopes.
 *
 * Why every method returns a Promise even when the default store is
 * synchronous: making the API async-uniform means the connection
 * lifecycle code is identical for memory vs Redis. The microtask
 * overhead on the hot path is in the nanoseconds — negligible next
 * to the network I/O the Redis store actually does.
 *
 * Atomicity contract: `claim()` MUST be atomic relative to other
 * `claim()` calls on the same pushRef. The in-memory store gets this
 * for free (single-threaded event loop). Redis stores MUST use a
 * Lua script or WATCH/MULTI/EXEC to test-and-set the principal.
 */

import { DeadQueue, type DeadQueueEntry } from "./dead-queue.js";
import { EnvelopeWriter } from "./envelope.js";

/** Stable principal string. Format: `u:<userId>`, `c:<clientId>`, `anon`, or `conn:<pushRef>`. */
export type Principal = string;

/**
 * Outcome of `claim()`. Note the `generation` and `supersededActive`
 * fields — they exist so the connection layer can detect AND fence a
 * stale active connection elsewhere in the cluster:
 *
 *   - `generation`        — monotonic per-pushRef counter. Bumped on
 *                           every successful claim. Lets the connection
 *                           tag its outbound writes with its own
 *                           generation, so the OLD live connection (if
 *                           any) can recognize it's been superseded.
 *
 *   - `supersededActive`  — true when the claim happened while the
 *                           previous entry was still `active`. Triggers
 *                           the fence path: caller closes any local
 *                           socket bound to this pushRef AND publishes
 *                           a cluster-wide fence so other nodes do too.
 *
 * Without this, two sockets in different processes can hold live
 * EnvelopeWriters for the same pushRef and race nextSeq + persist
 * (the 2.17.2 review's HIGH-2 finding). The fence mechanism makes
 * "newest claim wins" a hard invariant — the old socket is closed at
 * 4011 before any further writes can land.
 */
export type ClaimOutcome =
  | { outcome: "new"; envelope?: EnvelopeWriter; generation: number }
  | {
      outcome: "resumed";
      envelope?: EnvelopeWriter;
      generation: number;
      supersededActive: boolean;
    }
  | { outcome: "rejected"; reason: "principal_mismatch" | "capacity" };

/**
 * Snapshot of a single registry entry — what gets persisted in an
 * external store. `nextSeq` and `deadQueue` are tracked separately so
 * a reconnecting client picks up exactly where it left off (no seq
 * collisions, no replay gaps).
 */
export interface SerializedEntry {
  principal: Principal;
  nextSeq: number;
  deadQueue: DeadQueueEntry[];
  expiresAt: number;
  active: boolean;
  envelopeMode: "raw" | "seq";
  deadQueueSize: number;
  /**
   * Monotonic per-pushRef generation counter. Incremented on every
   * successful claim (new or resumed). The connection layer stamps
   * its writes with the generation in force at handshake time so a
   * stale live connection on another node can be fenced — its
   * generation is now strictly less than the latest.
   */
  generation: number;
}

/**
 * Persistence contract for cross-instance pushRef state.
 *
 * Implementations MUST guarantee atomic claim semantics — concurrent
 * claims for the same pushRef from different nodes resolve to exactly
 * one `new` / `resumed` outcome; the loser sees `rejected`.
 *
 * `stage` and `bumpActive` are mutation primitives the registry uses
 * for the offline-staging and reconnect paths; implementations may
 * optimize them (e.g. Redis HSET partial updates) but the default
 * implementation just reads the entry, mutates, writes back.
 */
/** Outcome of a fenced write — `stale` means the caller's generation lost. */
export type FencedWriteOutcome = "ok" | "missing" | "stale";

/**
 * Partial snapshot used by `releaseIfGen` / `persistIfGen` to flush the
 * live envelope's nextSeq + dead queue back to the store atomically.
 * Optional — caller may skip when no live envelope state exists (raw mode).
 */
export interface EnvelopeSnapshot {
  nextSeq: number;
  deadQueue: DeadQueueEntry[];
}

export interface PushRefStore {
  get(pushRef: string): Promise<SerializedEntry | undefined>;
  set(pushRef: string, entry: SerializedEntry): Promise<void>;
  delete(pushRef: string): Promise<void>;
  /**
   * Generation-fenced release. The 2.17.2 review surfaced this race:
   * after Node A is fenced by Node B's claim (generation = N+1), Node
   * A's close handler still fires `release(pushRef)` synchronously.
   * Without a generation check the release silently mutates Node B's
   * entry — marks it inactive, overwrites dead queue with Node A's
   * stale snapshot.
   *
   * The atomic contract:
   *   - If `stored.generation === expectedGeneration`: mark inactive,
   *     write snapshot (if provided), extend expiresAt — return `ok`.
   *   - If different: no-op, return `stale`.
   *   - If entry is absent: return `missing`.
   *
   * Implementations route this to native CAS — Redis uses a Lua script
   * so the test + write is single-roundtrip; Memory uses sync compare
   * inside the event-loop turn.
   */
  releaseIfGen(args: {
    pushRef: string;
    expectedGeneration: number;
    snapshot?: EnvelopeSnapshot;
    expiresAt: number;
  }): Promise<FencedWriteOutcome>;
  /**
   * Generation-fenced persist. Used by the room manager after each
   * critical send to round-trip the live envelope state to the store
   * so a reconnect to ANY node picks up the latest dead queue. Same
   * CAS contract as `releaseIfGen` — stale writes from a fenced
   * connection are dropped.
   */
  persistIfGen(args: {
    pushRef: string;
    expectedGeneration: number;
    snapshot: EnvelopeSnapshot;
    expiresAt: number;
  }): Promise<FencedWriteOutcome>;
  /**
   * Atomic offline-stage for a single payload. Used by the plugin's
   * `app.ws.send({pushRef})` path when no live socket is attached —
   * the payload is wrapped (seq + timestamp) into the dead queue so a
   * reconnect's RESUME replays it.
   *
   * Why this can't be `get + mutate + set`:
   *
   *   The 2.17.2 review (HIGH) — between the read and the write, another
   *   node can claim the pushRef and become the new active owner. A
   *   non-atomic stage would then overwrite the freshly-claimed active
   *   entry with the stale "inactive + old snapshot" view, losing the
   *   new owner's generation bump and any frames it had already written.
   *
   * The atomic contract — performed under a single Lua EVAL on Redis,
   * synchronously within the event-loop turn on Memory:
   *
   *   1. Read the entry. If missing → return 'missing'.
   *   2. If `active === true` → return 'active' (caller routes to live
   *      delivery instead; staging is for OFFLINE sessions only).
   *   3. If `envelopeMode !== 'seq'` → return 'raw' (no envelope means
   *      nothing to stage into).
   *   4. Compute seq = entry.nextSeq, bump nextSeq.
   *   5. Wrap the payload: `{seq, t, msg: payload}` and JSON-encode.
   *   6. Append `{seq, payload: encoded}` to deadQueue. Trim to ring size.
   *   7. Extend expiresAt. Write back.
   *
   * The wrap step happens INSIDE the atomic primitive because seq has
   * to come from the just-read entry — the registry layer cannot
   * pre-compute it without re-introducing the very race we're closing.
   */
  stageIfInactive(args: {
    pushRef: string;
    /** Raw payload (NOT pre-wrapped). The store assigns seq + wraps atomically. */
    payload: unknown;
    /** Server timestamp (ms) — passed in so tests can pin the clock. */
    timestamp: number;
    expiresAt: number;
  }): Promise<"ok" | "missing" | "active" | "raw">;
  /**
   * Atomic claim. Implementations route to native primitives:
   *   - Memory: single-threaded check-and-set
   *   - Redis: Lua script (EVAL) testing principal then HMSET
   *   - SQL: upsert with check constraint
   *
   * `mintFresh()` constructs a SerializedEntry for the new-claim path —
   * called only when no existing entry is found and the store has decided
   * to create one. (Lets the registry layer own the envelope-mint policy.)
   */
  claim(args: {
    pushRef: string;
    principal: Principal;
    now: number;
    ttlMs: number;
    mintFresh: () => SerializedEntry;
    maxEntries: number;
    countNonExpired: () => Promise<number>;
  }): Promise<{
    outcome: "new" | "resumed" | "rejected";
    entry?: SerializedEntry;
    /**
     * `true` when the previous entry was still marked active at the
     * moment of claim — caller MUST fence the previous owner so two
     * live sockets can't race the same envelope state.
     */
    supersededActive?: boolean;
  }>;
  /** Periodic GC — remove inactive entries past TTL. Returns count removed. */
  gc(now: number): Promise<number>;
  /** Total entries (active + inactive). */
  size(): Promise<number>;
  /** Cleanup any background resources (subscriptions, timers). */
  close?(): Promise<void>;
}

export interface PushRefRegistryOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Inject the store implementation. Defaults to `MemoryPushRefStore`. */
  store?: PushRefStore;
  /** Optional clock injection — tests can pin time. */
  now?: () => number;
}

/**
 * Default in-memory store — the previous single-instance registry's
 * behavior, repackaged behind the `PushRefStore` interface so the
 * registry layer doesn't care whether it's local or distributed.
 *
 * All methods are technically synchronous but return promises to
 * conform to the interface. Cost: one microtask per call. Negligible.
 */
export class MemoryPushRefStore implements PushRefStore {
  private entries = new Map<string, SerializedEntry>();

  async get(pushRef: string): Promise<SerializedEntry | undefined> {
    return this.entries.get(pushRef);
  }

  async set(pushRef: string, entry: SerializedEntry): Promise<void> {
    this.entries.set(pushRef, entry);
  }

  async delete(pushRef: string): Promise<void> {
    this.entries.delete(pushRef);
  }

  async claim(args: {
    pushRef: string;
    principal: Principal;
    now: number;
    ttlMs: number;
    mintFresh: () => SerializedEntry;
    maxEntries: number;
    countNonExpired: () => Promise<number>;
  }): Promise<{
    outcome: "new" | "resumed" | "rejected";
    entry?: SerializedEntry;
    supersededActive?: boolean;
  }> {
    const existing = this.entries.get(args.pushRef);
    if (existing) {
      if (!existing.active && existing.expiresAt <= args.now) {
        this.entries.delete(args.pushRef);
      } else {
        if (existing.principal !== args.principal) {
          return { outcome: "rejected" };
        }
        const supersededActive = existing.active === true;
        existing.active = true;
        existing.expiresAt = args.now + args.ttlMs;
        existing.generation = (existing.generation ?? 0) + 1;
        this.entries.set(args.pushRef, existing);
        return { outcome: "resumed", entry: existing, supersededActive };
      }
    }
    if (this.entries.size >= args.maxEntries && !this.evictOldestInactive()) {
      return { outcome: "rejected" };
    }
    const fresh = args.mintFresh();
    this.entries.set(args.pushRef, fresh);
    return { outcome: "new", entry: fresh };
  }

  async releaseIfGen(args: {
    pushRef: string;
    expectedGeneration: number;
    snapshot?: EnvelopeSnapshot;
    expiresAt: number;
  }): Promise<FencedWriteOutcome> {
    const entry = this.entries.get(args.pushRef);
    if (!entry) return "missing";
    if (entry.generation !== args.expectedGeneration) return "stale";
    entry.active = false;
    entry.expiresAt = args.expiresAt;
    if (args.snapshot) {
      entry.nextSeq = args.snapshot.nextSeq;
      entry.deadQueue = args.snapshot.deadQueue;
    }
    this.entries.set(args.pushRef, entry);
    return "ok";
  }

  async persistIfGen(args: {
    pushRef: string;
    expectedGeneration: number;
    snapshot: EnvelopeSnapshot;
    expiresAt: number;
  }): Promise<FencedWriteOutcome> {
    const entry = this.entries.get(args.pushRef);
    if (!entry) return "missing";
    if (entry.generation !== args.expectedGeneration) return "stale";
    entry.nextSeq = args.snapshot.nextSeq;
    entry.deadQueue = args.snapshot.deadQueue;
    entry.expiresAt = args.expiresAt;
    this.entries.set(args.pushRef, entry);
    return "ok";
  }

  async stageIfInactive(args: {
    pushRef: string;
    payload: unknown;
    timestamp: number;
    expiresAt: number;
  }): Promise<"ok" | "missing" | "active" | "raw"> {
    const entry = this.entries.get(args.pushRef);
    if (!entry) return "missing";
    if (entry.active) return "active";
    if (entry.envelopeMode !== "seq") return "raw";
    const seq = entry.nextSeq;
    entry.nextSeq = seq + 1;
    const serialized = JSON.stringify({ seq, t: args.timestamp, msg: args.payload });
    entry.deadQueue.push({ seq, payload: serialized });
    if (entry.deadQueue.length > entry.deadQueueSize) {
      entry.deadQueue = entry.deadQueue.slice(-entry.deadQueueSize);
    }
    entry.expiresAt = args.expiresAt;
    this.entries.set(args.pushRef, entry);
    return "ok";
  }

  async gc(now: number): Promise<number> {
    let removed = 0;
    for (const [k, v] of this.entries) {
      if (!v.active && v.expiresAt <= now) {
        this.entries.delete(k);
        removed++;
      }
    }
    return removed;
  }

  async size(): Promise<number> {
    return this.entries.size;
  }

  /** Test-only inspection — not in the PushRefStore interface. */
  inspect(pushRef: string): Readonly<SerializedEntry> | undefined {
    return this.entries.get(pushRef);
  }

  private evictOldestInactive(): boolean {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of this.entries) {
      if (!v.active && v.expiresAt < oldestTime) {
        oldestTime = v.expiresAt;
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) return false;
    this.entries.delete(oldestKey);
    return true;
  }
}

/**
 * Registry — the high-level interface connection.ts calls. Owns the
 * envelope-mint policy (envelope writers are LIVE objects with mutable
 * dead queues — they can't be reconstructed from a serialized snapshot
 * exactly because the `nextSeq` counter and ring buffer must round-trip
 * with full fidelity).
 *
 * The hot path:
 *
 *   1. `claim(pushRef, principal, deadQueueSize)` resolves the
 *      cross-connection state. On `new`, an EnvelopeWriter is minted
 *      around a fresh DeadQueue. On `resumed`, the EnvelopeWriter is
 *      reconstructed from the persisted nextSeq + deadQueue contents.
 *
 *   2. The connection lifecycle calls `release()` on close — starts the
 *      TTL countdown.
 *
 *   3. `stageForResume()` writes a payload into the orphan envelope
 *      when no live socket is attached (the offline-send path).
 *
 *   4. `persist()` flushes the in-memory EnvelopeWriter back to the
 *      store after each write — keeps the store in sync so a reconnect
 *      to a different node sees the latest dead queue. For the memory
 *      store this is a no-op; for Redis it's a HMSET write.
 */
export class PushRefRegistry {
  private store: PushRefStore;
  private ttlMs: number;
  private maxEntries: number;
  private now: () => number;
  /**
   * Live envelope writers indexed by pushRef. Stays in sync with the
   * store via persist() after every wrap(). On `claim('resumed')`,
   * rehydrated from the store's snapshot.
   */
  private liveEnvelopes = new Map<string, EnvelopeWriter>();

  constructor(opts: PushRefRegistryOptions = {}) {
    this.store = opts.store ?? new MemoryPushRefStore();
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  async claim(
    pushRef: string,
    principal: Principal,
    opts: {
      envelopeMode: "raw" | "seq";
      deadQueueSize: number;
    },
  ): Promise<ClaimOutcome> {
    const now = this.now();
    const result = await this.store.claim({
      pushRef,
      principal,
      now,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      countNonExpired: () => this.store.size(),
      mintFresh: () => ({
        principal,
        nextSeq: 1,
        deadQueue: [],
        expiresAt: now + this.ttlMs,
        active: true,
        envelopeMode: opts.envelopeMode,
        deadQueueSize: opts.deadQueueSize,
        generation: 1,
      }),
    });

    if (result.outcome === "rejected") {
      return { outcome: "rejected", reason: "principal_mismatch" };
    }
    if (!result.entry) {
      return { outcome: "rejected", reason: "principal_mismatch" };
    }

    const generation = result.entry.generation ?? 1;
    const envelope =
      opts.envelopeMode === "seq" ? this.hydrateEnvelope(pushRef, result.entry) : undefined;

    if (result.outcome === "new") {
      return { outcome: "new", envelope, generation };
    }
    return {
      outcome: "resumed",
      envelope,
      generation,
      supersededActive: result.supersededActive === true,
    };
  }

  /**
   * Mark the connection inactive (TTL countdown starts). Caller MUST
   * pass the generation they captured at claim time — the store does
   * a compare-and-set and silently no-ops if the entry has since been
   * superseded by a higher-generation claim (i.e. another node took
   * ownership while our close handler was pending).
   *
   * This closes the race the 2.17.2 review surfaced: previously, a
   * stale release could overwrite Node B's freshly-claimed entry with
   * Node A's outdated snapshot.
   *
   * Returns the outcome for callers that want to log fenced writes.
   */
  async release(pushRef: string, expectedGeneration: number): Promise<FencedWriteOutcome> {
    const env = this.liveEnvelopes.get(pushRef);
    const snapshot = env
      ? { nextSeq: env.peekNextSeq(), deadQueue: env.snapshotDeadQueue() }
      : undefined;
    const outcome = await this.store.releaseIfGen({
      pushRef,
      expectedGeneration,
      ...(snapshot ? { snapshot } : {}),
      expiresAt: this.now() + this.ttlMs,
    });
    // Always clear local liveEnvelope — this connection is gone either
    // way. The store-side state is the cluster's source of truth.
    this.liveEnvelopes.delete(pushRef);
    return outcome;
  }

  async evict(pushRef: string): Promise<void> {
    await this.store.delete(pushRef);
    this.liveEnvelopes.delete(pushRef);
  }

  /**
   * Stage a payload into the orphan envelope when no live socket is
   * attached. Atomic — routes through `store.stageIfInactive` which
   * does the read + wrap + write under a single Lua EVAL (Redis) or
   * synchronous event-loop turn (Memory). This closes the 2.17.2
   * stage-vs-claim race where a get-then-set could overwrite a freshly
   * claimed higher-generation entry with the stale inactive snapshot.
   *
   * Returns `true` only when the payload was actually staged. `false`
   * for any of:
   *   - entry missing (unknown / GC'd pushRef)
   *   - entry is currently active (route via room manager instead)
   *   - envelope mode is `'raw'` (no dead queue to stage into)
   */
  async stageForResume(pushRef: string, payload: unknown): Promise<boolean> {
    const outcome = await this.store.stageIfInactive({
      pushRef,
      payload,
      timestamp: this.now(),
      expiresAt: this.now() + this.ttlMs,
    });
    return outcome === "ok";
  }

  /**
   * Generation-fenced persist. Called by the room-manager hook after
   * every wrap() so the persisted snapshot stays in sync with the live
   * envelope. Caller passes the connection's generation; a stale
   * persist (after the connection was fenced) silently no-ops at the
   * store level — never overwrites the newer owner's state.
   *
   * Returns the outcome for callers that want to log fenced writes.
   */
  async persist(pushRef: string, expectedGeneration: number): Promise<FencedWriteOutcome> {
    const env = this.liveEnvelopes.get(pushRef);
    if (!env) return "missing";
    return this.store.persistIfGen({
      pushRef,
      expectedGeneration,
      snapshot: { nextSeq: env.peekNextSeq(), deadQueue: env.snapshotDeadQueue() },
      expiresAt: this.now() + this.ttlMs,
    });
  }

  async size(): Promise<number> {
    return this.store.size();
  }

  async gc(): Promise<number> {
    return this.store.gc(this.now());
  }

  async close(): Promise<void> {
    this.liveEnvelopes.clear();
    await this.store.close?.();
  }

  /** Diagnostics — read-only. */
  async inspect(pushRef: string): Promise<Readonly<SerializedEntry> | undefined> {
    return this.store.get(pushRef);
  }

  /** Reconstruct an EnvelopeWriter from a persisted snapshot. */
  private hydrateEnvelope(pushRef: string, entry: SerializedEntry): EnvelopeWriter {
    const existing = this.liveEnvelopes.get(pushRef);
    if (existing) return existing;
    const dq = new DeadQueue(entry.deadQueueSize);
    for (const e of entry.deadQueue) dq.push(e);
    const writer = new EnvelopeWriter(dq, { nextSeq: entry.nextSeq });
    this.liveEnvelopes.set(pushRef, writer);
    return writer;
  }
}

/**
 * Derive a stable principal string from a connection's identity. Used
 * as the pushRef binding key — two connections sharing a principal can
 * resume each other's pushRef state.
 *
 * Returns:
 *   - `'u:<userId>'`         — interactive user session
 *   - `'c:<clientId>'`       — service / machine-to-machine
 *   - `'anon'`               — auth disabled (dev / test)
 *   - **`null`**             — auth ENABLED but no stable identity
 *                              (org-only credentials, etc.) — caller
 *                              MUST refuse URL pushRef claims and mint
 *                              a connection-bound fresh binding.
 */
export function derivePrincipal(args: {
  userId?: string;
  clientId?: string;
  authMode: boolean;
}): Principal | null {
  if (args.userId) return `u:${args.userId}`;
  if (args.clientId) return `c:${args.clientId}`;
  if (!args.authMode) return "anon";
  return null;
}
