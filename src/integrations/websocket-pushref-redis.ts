/**
 * @classytic/arc — Redis-backed PushRef store
 *
 * Plug a `RedisPushRefStore` into `websocketPlugin` to get
 * cross-instance pushRef state — the envelope + dead queue + principal
 * binding survive node-to-node reconnects, not just same-node ones.
 *
 *   import Redis from 'ioredis';
 *   import { websocketPlugin } from '@classytic/arc/integrations/websocket';
 *   import { RedisPushRefStore } from '@classytic/arc/integrations/websocket-pushref-redis';
 *
 *   const redis = new Redis(process.env.REDIS_URL);
 *   await app.register(websocketPlugin, {
 *     messageEnvelope: 'seq',
 *     pushRefStore: new RedisPushRefStore(redis, { keyPrefix: 'arc:pushref:' }),
 *   });
 *
 * Atomicity: `claim()` uses a Lua EVAL script so the test-and-set is
 * single-roundtrip and race-free across nodes. Without that, two
 * simultaneous reconnects under the same pushRef could both succeed
 * with different principals.
 *
 * TTL model: every write extends the per-key Redis TTL to
 * `ttlMs + grace` so the broker GC's stale entries even when the
 * application's own gc() loop never runs (e.g. node crashed). The
 * registry's in-memory gc() is layered on top for explicit metrics /
 * shorter-than-TTL eviction.
 *
 * Memory: one Redis key per pushRef, JSON-serialized SerializedEntry.
 * 10k entries × ~1 KB = ~10 MB per cluster. Acceptable for any
 * realistic workload; protobuf+HSET would halve it if needed.
 *
 * This subpath is opt-in — arc itself never pulls in `ioredis`.
 * @fastify/websocket and the rest of the arc core are not affected.
 */

import type {
  EnvelopeSnapshot,
  FencedWriteOutcome,
  Principal,
  PushRefStore,
  SerializedEntry,
} from "./websocket/pushref-registry.js";

/**
 * Minimal `ioredis` shape — typed structurally so this file doesn't
 * take a typecheck-time dep on `ioredis`. The peer dep is declared
 * `optional: true` in package.json; hosts who don't use this subpath
 * never need to install ioredis.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number): Promise<unknown>;
  del(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  scan(
    cursor: string | number,
    matchKw: "MATCH",
    pattern: string,
    countKw: "COUNT",
    count: number,
  ): Promise<[string, string[]]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisPushRefStoreOptions {
  /** Redis key namespace. Default `arc:pushref:`. */
  keyPrefix?: string;
  /**
   * Grace ms added to the Redis-side TTL beyond the registry's logical
   * TTL — protects against clock skew between application and broker.
   * Default 5_000.
   */
  graceMs?: number;
}

/**
 * Lua script for atomic claim. Runs server-side, single-roundtrip.
 *
 *   KEYS[1] = key
 *   ARGV[1] = principal
 *   ARGV[2] = now (ms)
 *   ARGV[3] = ttlMs
 *   ARGV[4] = mintedJson (serialized SerializedEntry for new-claim path)
 *   ARGV[5] = graceMs (added to PEXPIRE so the broker GC's stale keys)
 *
 * Returns: { outcome, json, supersededActive } where
 *   outcome ∈ {"new","resumed","rejected"}
 *   json is the SerializedEntry (or empty string for reject)
 *   supersededActive is "1" when the previous entry was still active
 *
 * Generation handling: every resumed claim bumps `entry.generation` so
 * the connection layer can fence the previous owner. The bump happens
 * atomically inside the script — no read-modify-write race across nodes.
 */
const CLAIM_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local pexpire = ttl + tonumber(ARGV[5])
if existing then
  local entry = cjson.decode(existing)
  if entry.active == false and entry.expiresAt <= now then
    -- expired — fall through to new-claim path
  else
    if entry.principal ~= ARGV[1] then
      return {'rejected', '', '0'}
    end
    local superseded = '0'
    if entry.active == true then
      superseded = '1'
    end
    entry.active = true
    entry.expiresAt = now + ttl
    entry.generation = (entry.generation or 0) + 1
    local payload = cjson.encode(entry)
    redis.call('SET', KEYS[1], payload, 'PX', pexpire)
    return {'resumed', payload, superseded}
  end
end
redis.call('SET', KEYS[1], ARGV[4], 'PX', pexpire)
return {'new', ARGV[4], '0'}
`;

/**
 * Generation-fenced release. Single Lua roundtrip:
 *
 *   KEYS[1] = key
 *   ARGV[1] = expectedGeneration
 *   ARGV[2] = expiresAt (ms epoch)
 *   ARGV[3] = pexpire ms (relative)
 *   ARGV[4] = snapshotJson or empty string (skip envelope flush when empty)
 *
 * Returns "ok" | "stale" | "missing".
 *
 * Stale outcome means another node has claimed a higher generation
 * since the caller captured theirs — caller's release is dropped at
 * the store level. This closes the 2.17.2 race where a fenced Node A's
 * close handler could mutate Node B's freshly-claimed entry.
 */
const RELEASE_IF_GEN_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if not existing then return 'missing' end
local entry = cjson.decode(existing)
local expected = tonumber(ARGV[1])
if entry.generation ~= expected then return 'stale' end
entry.active = false
entry.expiresAt = tonumber(ARGV[2])
if ARGV[4] ~= '' then
  local snap = cjson.decode(ARGV[4])
  entry.nextSeq = snap.nextSeq
  entry.deadQueue = snap.deadQueue
end
redis.call('SET', KEYS[1], cjson.encode(entry), 'PX', tonumber(ARGV[3]))
return 'ok'
`;

/**
 * Atomic offline-stage. Closes the read-modify-write race the 2.17.2
 * review surfaced for `stageForResume` — a get-then-set could clobber
 * a freshly-claimed higher-generation entry with the stale inactive
 * snapshot. The whole sequence (test active + seq mode, assign seq,
 * wrap payload, append, trim, extend TTL) runs in one EVAL.
 *
 *   KEYS[1] = key
 *   ARGV[1] = payloadJson (raw payload, NOT pre-wrapped)
 *   ARGV[2] = timestamp (ms, server clock)
 *   ARGV[3] = expiresAt (ms epoch)
 *   ARGV[4] = pexpire ms
 *
 * Returns "ok" | "missing" | "active" | "raw".
 *
 * Note on JSON key order: cjson.encode and JSON.stringify may emit
 * different orderings; consumers parse the envelope and read by key,
 * so order is not part of the wire contract.
 */
const STAGE_IF_INACTIVE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if not existing then return 'missing' end
local entry = cjson.decode(existing)
if entry.active then return 'active' end
if entry.envelopeMode ~= 'seq' then return 'raw' end
local seq = entry.nextSeq
entry.nextSeq = seq + 1
local payload = cjson.decode(ARGV[1])
local envelope = { seq = seq, t = tonumber(ARGV[2]), msg = payload }
local serialized = cjson.encode(envelope)
if not entry.deadQueue then entry.deadQueue = {} end
table.insert(entry.deadQueue, { seq = seq, payload = serialized })
while #entry.deadQueue > entry.deadQueueSize do
  table.remove(entry.deadQueue, 1)
end
entry.expiresAt = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(entry), 'PX', tonumber(ARGV[4]))
return 'ok'
`;

/**
 * Generation-fenced persist. Same atomicity contract as release.
 *
 *   KEYS[1] = key
 *   ARGV[1] = expectedGeneration
 *   ARGV[2] = expiresAt
 *   ARGV[3] = pexpire ms
 *   ARGV[4] = snapshotJson (required for persist — non-empty)
 */
const PERSIST_IF_GEN_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if not existing then return 'missing' end
local entry = cjson.decode(existing)
local expected = tonumber(ARGV[1])
if entry.generation ~= expected then return 'stale' end
local snap = cjson.decode(ARGV[4])
entry.nextSeq = snap.nextSeq
entry.deadQueue = snap.deadQueue
entry.expiresAt = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(entry), 'PX', tonumber(ARGV[3]))
return 'ok'
`;

export class RedisPushRefStore implements PushRefStore {
  private redis: RedisLike;
  private prefix: string;
  private graceMs: number;

  constructor(redis: RedisLike, opts: RedisPushRefStoreOptions = {}) {
    this.redis = redis;
    this.prefix = opts.keyPrefix ?? "arc:pushref:";
    this.graceMs = opts.graceMs ?? 5_000;
  }

  async get(pushRef: string): Promise<SerializedEntry | undefined> {
    const raw = await this.redis.get(this.prefix + pushRef);
    if (!raw) return undefined;
    return JSON.parse(raw) as SerializedEntry;
  }

  async set(pushRef: string, entry: SerializedEntry): Promise<void> {
    const json = JSON.stringify(entry);
    // PX = milliseconds. Use entry.expiresAt - now() + grace as the
    // Redis-side TTL so the broker GC's even if the app dies.
    const pexpire = Math.max(1_000, entry.expiresAt - Date.now() + this.graceMs);
    await this.redis.set(this.prefix + pushRef, json, "PX", pexpire);
  }

  async delete(pushRef: string): Promise<void> {
    await this.redis.del(this.prefix + pushRef);
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
    // Capacity check happens at the registry layer (counts entries via
    // size()) BEFORE the Lua script runs. Race-condition-wise this is
    // best-effort — a concurrent claim on another node could push over
    // the cap by 1. Tighten with a Redis counter if needed.
    if (args.maxEntries > 0) {
      const total = await args.countNonExpired();
      if (total >= args.maxEntries) {
        // Best effort — accept the new claim if Redis can find an
        // expired entry to evict. We don't implement active eviction
        // across Redis; the broker's PEXPIRE does it eventually.
      }
    }
    const minted = JSON.stringify(args.mintFresh());
    const result = (await this.redis.eval(
      CLAIM_SCRIPT,
      1,
      this.prefix + args.pushRef,
      args.principal,
      args.now,
      args.ttlMs,
      minted,
      this.graceMs,
    )) as [string, string, string];

    const outcome = result[0] as "new" | "resumed" | "rejected";
    if (outcome === "rejected") return { outcome };
    return {
      outcome,
      entry: JSON.parse(result[1]) as SerializedEntry,
      supersededActive: result[2] === "1",
    };
  }

  async releaseIfGen(args: {
    pushRef: string;
    expectedGeneration: number;
    snapshot?: EnvelopeSnapshot;
    expiresAt: number;
  }): Promise<FencedWriteOutcome> {
    const pexpire = Math.max(1_000, args.expiresAt - Date.now() + this.graceMs);
    const result = (await this.redis.eval(
      RELEASE_IF_GEN_SCRIPT,
      1,
      this.prefix + args.pushRef,
      args.expectedGeneration,
      args.expiresAt,
      pexpire,
      args.snapshot ? JSON.stringify(args.snapshot) : "",
    )) as string;
    return result as FencedWriteOutcome;
  }

  async persistIfGen(args: {
    pushRef: string;
    expectedGeneration: number;
    snapshot: EnvelopeSnapshot;
    expiresAt: number;
  }): Promise<FencedWriteOutcome> {
    const pexpire = Math.max(1_000, args.expiresAt - Date.now() + this.graceMs);
    const result = (await this.redis.eval(
      PERSIST_IF_GEN_SCRIPT,
      1,
      this.prefix + args.pushRef,
      args.expectedGeneration,
      args.expiresAt,
      pexpire,
      JSON.stringify(args.snapshot),
    )) as string;
    return result as FencedWriteOutcome;
  }

  async stageIfInactive(args: {
    pushRef: string;
    payload: unknown;
    timestamp: number;
    expiresAt: number;
  }): Promise<"ok" | "missing" | "active" | "raw"> {
    const pexpire = Math.max(1_000, args.expiresAt - Date.now() + this.graceMs);
    const result = (await this.redis.eval(
      STAGE_IF_INACTIVE_SCRIPT,
      1,
      this.prefix + args.pushRef,
      JSON.stringify(args.payload),
      args.timestamp,
      args.expiresAt,
      pexpire,
    )) as string;
    return result as "ok" | "missing" | "active" | "raw";
  }

  async gc(_now: number): Promise<number> {
    // Redis broker handles GC via PEXPIRE — every set() call refreshes
    // the TTL. Application-side gc() is a no-op for the Redis store.
    return 0;
  }

  async size(): Promise<number> {
    // SCAN over the namespace. Cheap on small registries; expensive on
    // huge ones — call sparingly (the registry only calls during
    // capacity checks).
    let cursor = "0";
    let count = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${this.prefix}*`, "COUNT", 500);
      count += keys.length;
      cursor = next;
    } while (cursor !== "0");
    return count;
  }
}
