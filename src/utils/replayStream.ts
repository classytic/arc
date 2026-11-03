/**
 * Resumable SSE over a change log — the replay port for custom `openSseStream` routes.
 *
 * A live feed fed straight from the event bus loses whatever was published while
 * a client was reconnecting, and has no answer for "I was away for an hour". This
 * hub feeds frames from a repo-core `ChangeLogStore` instead: every frame's SSE
 * `id:` is the log cursor, a reconnect sends it back as `Last-Event-ID`, and the
 * hub replays the gap from the log or says, in one frame, that it cannot.
 *
 * ## Wire contract (shared with `@classytic/arc-next/sse`)
 *
 * Control frames carry no `id:` and never reach a client's data handler:
 *
 * | frame | when |
 * |---|---|
 * | `ready {cursor, resumed}` | first frame on every connection (see the `revoked` exception) |
 * | `resync {cursor, reason}` | the gap could not be replayed — reload the snapshot, continue from `cursor` |
 * | `revoked {reason}` | access ended; the stream closes right after. If access ends while the connection is still attaching, this is the only frame |
 * | `retry {reason}` | not final: the server closes right after; the client reconnects at once (with its cursor) and is authorized afresh |
 *
 * Server order on one connection: attach (buffering live entries) → `ready` →
 * the replayed frames OR exactly one `resync` → the buffer → live. A tailed
 * entry the replay already sent is never sent again.
 *
 * | client sent | server sends |
 * |---|---|
 * | no `Last-Event-ID` | `ready{cursor: head, resumed: false}`, no `resync` |
 * | a cursor it can replay | `ready{cursor: head, resumed: true}`, then the replay |
 * | a cursor it cannot replay (expired, more than `maxReplay` behind, invalid) | `ready{cursor: head, resumed: false}`, then `resync{cursor: head, reason}` |
 *
 * An id-only frame (`id: <cursor>`, no data) follows a batch of entries this
 * subscriber was not shown (`toFrame` → `null`), so its reconnect cursor keeps up
 * with the log and a short blip does not turn into `gap_too_large`.
 *
 * ## Mechanics
 *
 * - Subscribers are grouped into PARTITIONS by `readScope(ctx)`; each partition
 *   tails the log once (`since(cursor, scope)`), however many subscribers it has.
 * - The tail wakes on {@link ReplayHub.notify} (call it from a bus subscriber) and
 *   every `pollMs`. The bus only wakes it — frames always come from the log, so a
 *   duplicated bus event is harmless.
 * - Backpressure: a replay or a live burst never outruns the socket. When the
 *   stream reports a full buffer (`needsDrain`, from `openSseStream`), the hub
 *   queues what follows for that subscriber and writes it on `drain`, in order,
 *   so a resume of megabytes stays inside the stream's byte budget. A client
 *   that stops reading is cut by the stream's drain timeout; its queue is capped.
 * - Cursors stay OPAQUE by default: a replayed entry is recognised later by its
 *   cursor (a set kept per subscriber), never by comparing cursors. With
 *   `compareCursors` the hub skips every tailed entry at or below the last cursor
 *   the client holds, and a cursor ahead of head becomes `cursor_invalid`.
 *   Without it, a client resuming from a cursor AHEAD of this replica's head (it
 *   read a newer entry through another replica a moment ago) may see the entries
 *   in between again — pass `compareCursors` when cursors are ordered.
 *
 * Fixed-width cursors (mongokit, `MemoryChangeLogStore`: 16-digit zero-padded):
 * `isValidCursor: (c) => /^\d{16}$/.test(c)`, `compareCursors: (a, b) => (a < b ? -1 : a > b ? 1 : 0)`.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { ChangeEntry, ChangeLogStore, ChangesSinceOptions } from "@classytic/repo-core/sync";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { arcLog } from "../logger/index.js";
import { registerSseStats } from "./sseStats.js";
import type { SseStream } from "./sseStream.js";
import {
  type ReadyFrame,
  type ResyncFrame,
  type ResyncReason,
  type RetryFrame,
  type RevokedFrame,
  STREAM_FRAMES,
  type StreamFrameName,
} from "./streamFrames.js";

export {
  type ReadyFrame,
  type ResyncFrame,
  type ResyncReason,
  type RetryFrame,
  type RevokedFrame,
  STREAM_FRAMES,
  type StreamFrameName,
} from "./streamFrames.js";

const log = arcLog("replay-stream");

// ============================================================================
// Hub API
// ============================================================================

/**
 * Identity keys a revoke matches on, e.g. `{ userId }`, `{ sessionId }`, `{ deviceId }`.
 * Values are compared as strings (`String(value)`), so an ObjectId or a number
 * returned by a loosely typed `identify` still matches.
 */
export type RevokeTarget = Readonly<Record<string, string>>;

/** The scope a partition tails with — passed to `store.since()` verbatim. */
export type ReplayReadScope = Pick<ChangesSinceOptions, "tenantId" | "scopes" | "sharedScopes">;

/**
 * A `revalidate.check` outcome that closes the stream with a stated frame:
 *
 * - `{ close: 'revoke', reason }` writes `revoked {reason}` (final; default reason
 *   `'access_ended'`, the same as returning `null`), e.g. `'mfa_required'`.
 * - `{ close: 'retry', reason }` writes `retry {reason}` (NOT final; default reason
 *   `'retry'`) and closes, so the client reconnects at once and is authorized
 *   afresh, e.g. after a session lookup that could not be confirmed.
 *
 * Recognised only as an object with exactly these keys, so a ctx that happens to
 * carry a `close` field is never mistaken for it.
 */
export interface ReplayCloseVerdict {
  close: "retry" | "revoke";
  reason?: string;
}

/** Injected timers (tests). Defaults to the global `setInterval` / `clearInterval`. */
export interface ReplayHubTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ReplayHubOptions<TDoc = unknown, TCtx = unknown> {
  /** The change log frames are read from. */
  store: ChangeLogStore<TDoc>;
  /**
   * Turn one log entry into the frame THIS subscriber sees (`data` is JSON-encoded).
   * Return `null` to hide the entry from this subscriber; its cursor still advances
   * (an id-only frame tells the client). A throw hides the entry too (logged).
   */
  toFrame(entry: ChangeEntry<TDoc>, ctx: TCtx): { event: string; data: unknown } | null;
  /**
   * The tail partition key and `since()` filter for a subscriber, e.g.
   * `{ tenantId: ctx.orgId, scopes: ['alerts'] }`. Default `{}` (one partition, no filter).
   * A platform-wide reader passes no `tenantId`.
   */
  readScope?(ctx: TCtx): ReplayReadScope;
  /**
   * Most log entries a reconnect replays; more than this is `resync 'gap_too_large'`.
   * Entries hidden from the subscriber count too (the log is read before `toFrame`).
   * Default 500.
   */
  maxReplay?: number;
  /** Tail poll interval in ms. Default 1000; `0` = woken by `notify()` only. */
  pollMs?: number;
  /** `false` → `resync 'cursor_invalid'` without touching the store. */
  isValidCursor?(cursor: string): boolean;
  /**
   * Cursor order (`< 0`, `0`, `> 0`). Lets the hub detect a cursor AHEAD of head
   * (`'cursor_invalid'`) and skip tailed entries the client already holds by order.
   */
  compareCursors?(a: string, b: string): number;
  /**
   * Periodic access re-check, one hub-wide interval. Per subscriber `check` never
   * overlaps itself. `null`, `undefined` or `false` → `revoked {reason: 'access_ended'}`
   * and close; a {@link ReplayCloseVerdict} → `revoked {reason}` or `retry {reason}`
   * and close; a ctx → it replaces the old one (a ctx whose `readScope` differs closes
   * the stream, so the client reconnects into the right partition); a throw counts
   * `revalidateFailures` and KEEPS the stream (an auth outage does not drop every
   * viewer, so a revoked user keeps streaming until a check succeeds; pair with
   * {@link ReplayHub.revoke} for immediate effect), up to `maxConsecutiveFailures`.
   * `tick.memo` is shared by every check in one tick — cache per-user grants there.
   */
  revalidate?: {
    everyMs: number;
    check(
      ctx: TCtx,
      tick: { memo: Map<string, unknown> },
    ): Promise<TCtx | ReplayCloseVerdict | null | undefined | false>;
    /**
     * Throws in a row, per subscriber, after which the stream closes with
     * `retry {reason: 'revalidate_failed'}` (the client reconnects at once and is
     * authorized afresh) instead of streaming on unchecked. Any other outcome
     * resets the count. Default: unset (a throw always keeps the stream).
     */
    maxConsecutiveFailures?: number;
  };
  /** Identity keys {@link ReplayHub.revoke} matches against. Without it, `revoke` matches nothing. */
  identify?(ctx: TCtx): RevokeTarget;
  /**
   * Broadcast `revoke()` to every replica over `fastify.events` (needs arc's events
   * plugin). The message is sealed with AES-256-GCM under a key derived from
   * `secret`, so the bus, `ssePlugin` clients (its default `'*'` pattern) and webhook
   * subscribers see only that a revoke happened — not who, nor the reason. Every
   * replica must use the same `secret` (at least 16 characters); a message sealed
   * under another secret is ignored. `type` defaults to `'arc.realtime.revoke'`.
   */
  revokeVia?: { secret: string; type?: string };
  /** Injected timers (tests). */
  timers?: ReplayHubTimers;
}

export interface ReplaySubscription<TCtx> {
  /** The subscriber's CURRENT ctx (revalidation may have replaced it). */
  readonly ctx: TCtx;
  /** `true` once the stream is closed (by the client, the hub, or a store failure at attach). */
  readonly closed: boolean;
  /** Detach and close the stream. Idempotent. */
  close(): void;
}

export interface ReplayHubStats {
  subscribers: number;
  partitions: number;
  /** Entries replayed to reconnecting clients, cumulative. */
  replayed: number;
  /** `resync` frames sent, cumulative. */
  resyncs: number;
  /** `revoked` frames sent, cumulative. */
  revoked: number;
  /** Revalidate checks that threw, cumulative. */
  revalidateFailures: number;
  /** `retry` frames sent, cumulative. */
  retried: number;
}

export interface ReplayHub<TCtx> {
  /**
   * Attach an open stream. Writes `ready`, then the replay or one `resync`, then
   * goes live. Resolves once the replay has been handed to the socket (a large
   * replay to a slow reader waits for `drain`, see the module note). Never rejects
   * for a store failure: the stream is closed with no frame (the client retries)
   * and the returned subscription reads `closed`.
   */
  attach(
    stream: SseStream,
    ctx: TCtx,
    lastEventId: string | null,
  ): Promise<ReplaySubscription<TCtx>>;
  /** Wake every partition's tail. Coalesced and single-flight per partition. */
  notify(): void;
  /**
   * Close every local subscriber whose `identify(ctx)` matches all keys of `target`,
   * after a `revoked {reason}` frame (default reason `'revoked'`). With `revokeVia`,
   * also broadcast to the other replicas. Resolves with the LOCAL count.
   *
   * Local subscribers are closed before the broadcast, so a rejected publish still
   * closed them. No record is kept: a connection authorized just before `revoke()`
   * and attached just after it stays open until `revalidate` catches it — revoke the
   * credential at the auth layer too.
   */
  revoke(target: RevokeTarget, reason?: string): Promise<number>;
  stats(): ReplayHubStats;
  /** Close every stream and stop all timers. Idempotent; also runs on `fastify.close()`. */
  close(): void;
}

// ============================================================================
// Request helper
// ============================================================================

/** C0 controls and DEL — never valid in an SSE id, and a header-injection shape. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The resume cursor a client sent: the `last-event-id` header first, then the
 * `queryParam` query parameter (default `'lastEventId'`; native `EventSource`
 * cannot set headers on a fresh instance). `null` when absent, empty, longer than
 * 256 chars, or containing control characters. Pass `queryParam: null` to read
 * the header only.
 */
export function lastEventIdOf(
  request: FastifyRequest,
  opts: { queryParam?: string | null } = {},
): string | null {
  const queryParam = opts.queryParam === undefined ? "lastEventId" : opts.queryParam;
  const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
  let value = first(request.headers["last-event-id"]);
  if ((value === undefined || value === "") && queryParam) {
    value = first((request.query as Record<string, unknown> | undefined)?.[queryParam]);
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  return hasControlChar(value) ? null : value;
}

// ============================================================================
// Implementation
// ============================================================================

const PAGE_LIMIT = 500;
const DEFAULT_MAX_REPLAY = 500;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_REVOKE_TYPE = "arc.realtime.revoke";
const MIN_REVOKE_SECRET_LENGTH = 16;

/** `CursorExpiredError` by NAME — a second copy of repo-core must still match. */
function isCursorExpired(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "CursorExpiredError"
  );
}

/** A {@link ReplayCloseVerdict}: exactly `{ close: 'retry' | 'revoke', reason?: string }`. */
function isCloseVerdict(value: unknown): value is ReplayCloseVerdict {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.close !== "retry" && v.close !== "revoke") return false;
  if (v.reason !== undefined && typeof v.reason !== "string") return false;
  return Object.keys(v).every((k) => k === "close" || k === "reason");
}

interface Joiner<TDoc, TCtx> {
  readonly sub: Subscriber<TDoc, TCtx>;
  /** Admitted once a page whose read STARTED after the join request has been delivered. */
  readonly minPage: number;
  resolve(head: string): void;
  reject(error: unknown): void;
}

interface Partition<TDoc, TCtx> {
  readonly key: string;
  readonly scope: ReplayReadScope;
  cursor: string;
  /** `false` until `latestCursor` has set `cursor`; the tail never pulls before. */
  initialized: boolean;
  readonly subs: Set<Subscriber<TDoc, TCtx>>;
  pulling: Promise<void> | null;
  dirty: boolean;
  ready: Promise<void>;
  /** Attaches in flight for this partition; it is not dropped while any are. */
  pending: number;
  /** Page reads started, ever (a sequence number). */
  pagesStarted: number;
  /** Attaches waiting to join at the next page boundary. */
  joiners: Joiner<TDoc, TCtx>[];
}

interface Subscriber<TDoc, TCtx> {
  readonly stream: SseStream;
  ctx: TCtx;
  /** `JSON.stringify(readScope(ctx))`, fixed at attach; a revalidated ctx must keep it. */
  scopeKey: string | undefined;
  partition: Partition<TDoc, TCtx> | undefined;
  /**
   * Entries waiting for this subscriber, in order: live entries that arrived while
   * the replay was being read or while the socket buffer was full. `null` = live.
   */
  buffer: ChangeEntry<TDoc>[] | null;
  /** Cursors the replay sent (no `compareCursors`); a tailed entry in here is skipped once. */
  skip: Set<string> | null;
  /** With `compareCursors`: tailed entries at or below this cursor were already sent. */
  floor: string | null;
  /** Cursor of the latest entry offered but hidden; written as an id-only frame. */
  unsent: string | null;
  closed: boolean;
  revalidating: boolean;
  /** Revalidate throws in a row (reset by any other outcome). */
  failures: number;
}

/** Structural view of arc's `fastify.events` facade (utils sits below the events layer). */
interface EventsFacade {
  publish(type: string, payload: unknown): Promise<unknown>;
  subscribe(
    pattern: string,
    handler: (event: { payload?: unknown }) => void | Promise<void>,
  ): Promise<() => void>;
}

interface RevokeMessage {
  origin: string;
  reason: string;
  keys: Record<string, string>;
}

/** What crosses the bus: the sealed {@link RevokeMessage}, nothing else. */
interface SealedRevoke {
  v: 1;
  sealed: string;
}

/** AES-256-GCM over the revoke message; `iv(12) | tag(16) | ciphertext`, base64. */
function revokeSealer(secret: string) {
  const key = Buffer.from(hkdfSync("sha256", secret, "", "arc.realtime.revoke/v1", 32));
  return {
    seal(msg: RevokeMessage): SealedRevoke {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(msg), "utf8"), cipher.final()]);
      return { v: 1, sealed: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64") };
    },
    /** `undefined` for anything not sealed under this secret. */
    open(payload: unknown): RevokeMessage | undefined {
      const sealed = (payload as Partial<SealedRevoke> | undefined)?.sealed;
      if (typeof sealed !== "string") return undefined;
      try {
        const raw = Buffer.from(sealed, "base64");
        if (raw.length < 29) return undefined;
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        const msg = JSON.parse(text.toString("utf8")) as Partial<RevokeMessage>;
        if (
          typeof msg.origin !== "string" ||
          typeof msg.keys !== "object" ||
          msg.keys === null ||
          Array.isArray(msg.keys)
        ) {
          return undefined;
        }
        return {
          origin: msg.origin,
          reason: typeof msg.reason === "string" ? msg.reason : "revoked",
          keys: msg.keys,
        };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Create a replay hub. Call at boot, before `ready`: it registers the
 * `fastify.sseStats()` provider, the cross-replica revoke subscription (with
 * `revokeVia`) and an `onClose` hook.
 *
 * ```ts
 * const hub = createReplayHub(app, {
 *   store: alertLog,                                   // a ChangeLogStore
 *   readScope: (ctx) => ({ tenantId: ctx.orgId, scopes: ['alerts'] }),
 *   toFrame: (entry, ctx) => (sees(ctx, entry) ? { event: 'alert', data: forViewer(ctx, entry) } : null),
 *   isValidCursor: (c) => /^\d{16}$/.test(c),
 *   compareCursors: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
 *   revalidate: { everyMs: 15_000, check: (ctx, { memo }) => stillAllowed(ctx, memo) },
 *   identify: (ctx) => ({ userId: ctx.userId, sessionId: ctx.sessionId }),
 *   revokeVia: { secret: process.env.REALTIME_REVOKE_SECRET! },
 * });
 * await app.events.subscribe('alert.*', () => hub.notify());
 *
 * app.get('/alerts/stream', async (req, reply) => {
 *   const ctx = await authorize(req);                  // every gate BEFORE the hijack
 *   const stream = openSseStream(req, reply);
 *   await hub.attach(stream, ctx, lastEventIdOf(req));
 * });
 * ```
 */
export function createReplayHub<TDoc = unknown, TCtx = unknown>(
  fastify: FastifyInstance,
  options: ReplayHubOptions<TDoc, TCtx>,
): ReplayHub<TCtx> {
  const { store, toFrame, compareCursors } = options;
  const maxReplay = options.maxReplay ?? DEFAULT_MAX_REPLAY;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(maxReplay) || maxReplay < 0) {
    throw new Error(
      `createReplayHub: maxReplay must be an integer >= 0, got ${String(maxReplay)}.`,
    );
  }
  if (!Number.isFinite(pollMs) || pollMs < 0) {
    throw new Error(
      `createReplayHub: pollMs must be a non-negative number, got ${String(pollMs)}.`,
    );
  }
  if (
    options.revalidate &&
    (!Number.isFinite(options.revalidate.everyMs) || options.revalidate.everyMs <= 0)
  ) {
    throw new Error(
      `createReplayHub: revalidate.everyMs must be a positive number, got ${String(options.revalidate.everyMs)}.`,
    );
  }
  const maxFailures = options.revalidate?.maxConsecutiveFailures;
  if (maxFailures !== undefined && (!Number.isInteger(maxFailures) || maxFailures < 1)) {
    throw new Error(
      `createReplayHub: revalidate.maxConsecutiveFailures must be an integer >= 1, got ${String(maxFailures)}.`,
    );
  }
  if (
    options.revokeVia &&
    (typeof options.revokeVia.secret !== "string" ||
      options.revokeVia.secret.length < MIN_REVOKE_SECRET_LENGTH)
  ) {
    throw new Error(
      `createReplayHub: revokeVia.secret must be a string of at least ${MIN_REVOKE_SECRET_LENGTH} characters, shared by every replica.`,
    );
  }
  const timers: ReplayHubTimers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const readScope = (ctx: TCtx): ReplayReadScope => options.readScope?.(ctx) ?? {};
  const origin = randomBytes(8).toString("hex");
  const revokeType = options.revokeVia
    ? (options.revokeVia.type ?? DEFAULT_REVOKE_TYPE)
    : undefined;
  const sealer = options.revokeVia ? revokeSealer(options.revokeVia.secret) : undefined;

  const subscribers = new Set<Subscriber<TDoc, TCtx>>();
  const partitions = new Map<string, Partition<TDoc, TCtx>>();
  const counters = { replayed: 0, resyncs: 0, revoked: 0, revalidateFailures: 0, retried: 0 };
  let hubClosed = false;
  let pollTimer: unknown;
  let revalidateTimer: unknown;
  let notifyQueued = false;
  let revokeUnsub: (() => void) | undefined;
  let warnedNonStringIdentity = false;
  const bufferCap = Math.max(1_000, maxReplay * 2);

  const unref = (handle: unknown): void => {
    (handle as { unref?: () => void } | undefined)?.unref?.();
  };

  // ---------------------------------------------------------------- writing

  const writeControl = (
    sub: Subscriber<TDoc, TCtx>,
    event: StreamFrameName,
    frame: object,
  ): void => {
    if (!sub.closed) sub.stream.write(event, JSON.stringify(frame));
  };

  /** Write one entry to a subscriber, or remember its cursor when it is hidden. */
  const writeEntry = (sub: Subscriber<TDoc, TCtx>, entry: ChangeEntry<TDoc>): void => {
    if (sub.closed) return;
    let frame: { event: string; data: unknown } | null;
    try {
      frame = toFrame(entry, sub.ctx);
    } catch (error) {
      log.error(
        `toFrame threw for cursor '${entry.cursor}'; entry hidden from this subscriber`,
        error,
      );
      frame = null;
    }
    if (!frame) {
      sub.unsent = entry.cursor;
      return;
    }
    sub.unsent = null;
    // `false` = destroyed on backpressure; the stream's cleanup detaches us.
    if (!sub.stream.write(frame.event, JSON.stringify(frame.data), entry.cursor)) detach(sub);
  };

  /** Move the client's `lastEventId` past entries it was not shown (id-only frame). */
  const checkpoint = (sub: Subscriber<TDoc, TCtx>): void => {
    if (sub.closed || sub.buffer || sub.unsent === null) return;
    const cursor = sub.unsent;
    sub.unsent = null;
    if (sub.stream.writeId && !sub.stream.writeId(cursor)) detach(sub);
  };

  /** `true` when the replay already sent this tailed entry. */
  const alreadySent = (sub: Subscriber<TDoc, TCtx>, entry: ChangeEntry<TDoc>): boolean => {
    if (sub.floor !== null && compareCursors) {
      if (compareCursors(entry.cursor, sub.floor) <= 0) return true;
      // The tail is ordered: nothing after this entry can be at or below the floor.
      sub.floor = null;
      return false;
    }
    if (sub.skip?.delete(entry.cursor)) {
      if (sub.skip.size === 0) sub.skip = null;
      return true;
    }
    return false;
  };

  /** The stream's socket buffer is full (only streams that report it, e.g. `openSseStream`). */
  const backpressured = (sub: Subscriber<TDoc, TCtx>): boolean =>
    sub.stream.needsDrain === true && typeof sub.stream.drain === "function";

  /** Wait for the stream's `drain`; `false` when the subscriber closed first. */
  const drained = async (sub: Subscriber<TDoc, TCtx>): Promise<boolean> => {
    const ok = await sub.stream.drain?.();
    return ok !== false && !sub.closed;
  };

  /** Write a tailed entry unless the replay already sent it. */
  const sendLive = (sub: Subscriber<TDoc, TCtx>, entry: ChangeEntry<TDoc>): void => {
    if (sub.closed || alreadySent(sub, entry)) return;
    writeEntry(sub, entry);
  };

  /**
   * Write `sub.buffer` in order, waiting for `drain` whenever the socket is full,
   * then go live (`buffer = null`) and checkpoint. Entries delivered meanwhile join
   * the buffer, so order holds. Never rejects.
   */
  const flush = async (sub: Subscriber<TDoc, TCtx>): Promise<void> => {
    for (;;) {
      if (sub.closed) return;
      if (backpressured(sub) && !(await drained(sub))) return;
      const buffer = sub.buffer;
      if (buffer === null) return;
      const entry = buffer.shift();
      if (entry === undefined) {
        sub.buffer = null;
        checkpoint(sub);
        return;
      }
      sendLive(sub, entry);
    }
  };

  /** Hand a tailed entry to a subscriber that is past its replay. */
  const deliverLive = (sub: Subscriber<TDoc, TCtx>, entry: ChangeEntry<TDoc>): void => {
    sendLive(sub, entry);
    // The socket is full: queue what follows and write it on `drain`, in order.
    if (!sub.closed && sub.buffer === null && backpressured(sub)) {
      sub.buffer = [];
      void flush(sub);
    }
  };

  /** Route a tailed entry: buffered while the subscriber is still replaying. */
  const deliver = (sub: Subscriber<TDoc, TCtx>, entry: ChangeEntry<TDoc>): void => {
    if (sub.closed) return;
    if (sub.buffer) {
      sub.buffer.push(entry);
      // A hot log during a slow replay or a slow reader: drop the connection rather
      // than grow without bound. The client reconnects with its last id and resumes.
      if (sub.buffer.length > bufferCap) sub.stream.close();
      return;
    }
    deliverLive(sub, entry);
  };

  // ---------------------------------------------------------------- partitions

  const stopTimersIfIdle = (): void => {
    if (subscribers.size > 0) return;
    if (pollTimer !== undefined) timers.clearInterval(pollTimer);
    if (revalidateTimer !== undefined) timers.clearInterval(revalidateTimer);
    pollTimer = undefined;
    revalidateTimer = undefined;
  };

  /** Stop tailing a partition nobody reads and nobody is joining. */
  const dropIfIdle = (p: Partition<TDoc, TCtx>): void => {
    if (p.subs.size === 0 && p.pending === 0 && partitions.get(p.key) === p) {
      partitions.delete(p.key);
    }
  };

  const detach = (sub: Subscriber<TDoc, TCtx>): void => {
    if (sub.closed) return;
    sub.closed = true;
    sub.buffer = null;
    sub.skip = null;
    subscribers.delete(sub);
    const p = sub.partition;
    if (p) {
      p.subs.delete(sub);
      dropIfIdle(p);
    }
    stopTimersIfIdle();
  };

  const tailError = (p: Partition<TDoc, TCtx>, error: unknown): void => {
    log.warn(`change-log tail failed for partition ${p.key}; retrying on the next wake`, error);
  };

  /**
   * The tail cursor was compacted away under us: every subscriber of the partition
   * has a gap. Jump to head and tell live subscribers to resync; close the ones
   * still replaying or waiting for `drain` (they reconnect).
   */
  const recoverExpiredTail = async (p: Partition<TDoc, TCtx>): Promise<void> => {
    const head = await store.latestCursor({ tenantId: p.scope.tenantId, scopes: p.scope.scopes });
    p.cursor = head;
    for (const sub of [...p.subs]) {
      if (sub.buffer) {
        sub.stream.close();
        continue;
      }
      sub.skip = null;
      sub.floor = null;
      sub.unsent = null;
      counters.resyncs++;
      writeControl(sub, STREAM_FRAMES.RESYNC, {
        cursor: head,
        reason: "cursor_expired",
      } satisfies ResyncFrame);
    }
  };

  /** Admit the joiners whose required page has been delivered (`seq` = that page). */
  const admitJoiners = (p: Partition<TDoc, TCtx>, seq: number): void => {
    if (p.joiners.length === 0) return;
    const waiting: Joiner<TDoc, TCtx>[] = [];
    for (const j of p.joiners) {
      if (j.minPage > seq) {
        waiting.push(j);
        continue;
      }
      if (!j.sub.closed) {
        j.sub.partition = p;
        p.subs.add(j.sub);
      }
      j.resolve(p.cursor);
    }
    p.joiners = waiting;
  };

  const rejectJoiners = (p: Partition<TDoc, TCtx>, error: unknown): void => {
    const joiners = p.joiners;
    p.joiners = [];
    for (const j of joiners) j.reject(error);
  };

  /**
   * Single-flight tail pull. A call during a pull marks the partition dirty, so the
   * running loop goes round once more — no wake is lost, no pull overlaps.
   *
   * INVARIANT: delivery, `p.cursor` and admission of joiners advance in one
   * synchronous step, so a subscriber joined at head `h` receives every entry after
   * `h`. A joiner waits for at most the page in flight plus one fresh page, never
   * for the dirty loop to go quiet (a hot log would otherwise starve new connections).
   */
  const pull = (p: Partition<TDoc, TCtx>): Promise<void> => {
    if (p.pulling !== null) {
      p.dirty = true;
      return p.pulling;
    }
    p.pulling = (async () => {
      try {
        do {
          p.dirty = false;
          for (;;) {
            const seq = ++p.pagesStarted;
            let page: Awaited<ReturnType<ChangeLogStore<TDoc>["since"]>>;
            try {
              page = await store.since(p.cursor, { ...p.scope, limit: PAGE_LIMIT });
            } catch (error) {
              if (!isCursorExpired(error)) throw error;
              await recoverExpiredTail(p);
              admitJoiners(p, Number.POSITIVE_INFINITY);
              break;
            }
            for (const entry of page.changes) {
              for (const sub of [...p.subs]) deliver(sub, entry);
            }
            p.cursor = page.cursor;
            for (const sub of [...p.subs]) checkpoint(sub);
            admitJoiners(p, seq);
            if (!page.hasMore || page.changes.length === 0) break;
          }
        } while (p.dirty && !hubClosed);
      } catch (error) {
        rejectJoiners(p, error);
        throw error;
      } finally {
        p.pulling = null;
        // Only reachable with joiners left when the hub closed mid-loop; their attach
        // sees the closed subscriber and returns.
        admitJoiners(p, Number.POSITIVE_INFINITY);
      }
    })();
    return p.pulling;
  };

  const pullAll = (): void => {
    for (const p of partitions.values()) {
      // Before `latestCursor` resolves the cursor is "", which reads the whole log.
      if (!p.initialized) continue;
      pull(p).catch((error: unknown) => tailError(p, error));
    }
  };

  /** Join `p` at the next page boundary; resolves with the head the subscriber joined at. */
  const join = (p: Partition<TDoc, TCtx>, sub: Subscriber<TDoc, TCtx>): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      p.joiners.push({ sub, minPage: p.pagesStarted + 1, resolve, reject });
      // A failure rejects this joiner; attach logs it.
      pull(p).catch(() => {});
    });

  /** Get or create the partition and count one pending attach on it (synchronous). */
  const partitionFor = (scope: ReplayReadScope, key: string): Partition<TDoc, TCtx> => {
    let p = partitions.get(key);
    if (!p) {
      const created: Partition<TDoc, TCtx> = {
        key,
        scope,
        cursor: "",
        initialized: false,
        subs: new Set(),
        pulling: null,
        dirty: false,
        ready: Promise.resolve(),
        pending: 0,
        pagesStarted: 0,
        joiners: [],
      };
      created.ready = store
        .latestCursor({ tenantId: scope.tenantId, scopes: scope.scopes })
        .then((head) => {
          created.cursor = head;
          created.initialized = true;
        })
        .catch((error: unknown) => {
          // Let the next attach retry instead of pinning a rejected partition.
          if (partitions.get(key) === created) partitions.delete(key);
          throw error;
        });
      partitions.set(key, created);
      p = created;
    }
    p.pending++;
    return p;
  };

  // ---------------------------------------------------------------- timers

  const ensureTimers = (): void => {
    if (pollMs > 0 && pollTimer === undefined) {
      pollTimer = timers.setInterval(pullAll, pollMs);
      unref(pollTimer);
    }
    if (options.revalidate && revalidateTimer === undefined) {
      revalidateTimer = timers.setInterval(revalidateTick, options.revalidate.everyMs);
      unref(revalidateTimer);
    }
  };

  const revokeSub = (sub: Subscriber<TDoc, TCtx>, reason: string): void => {
    if (sub.closed) return;
    counters.revoked++;
    writeControl(sub, STREAM_FRAMES.REVOKED, { reason } satisfies RevokedFrame);
    sub.stream.close();
    detach(sub);
  };

  /** Close with a non-final `retry {reason}`: the client reconnects at once. */
  const retrySub = (sub: Subscriber<TDoc, TCtx>, reason: string): void => {
    if (sub.closed) return;
    counters.retried++;
    writeControl(sub, STREAM_FRAMES.RETRY, { reason } satisfies RetryFrame);
    sub.stream.close();
    detach(sub);
  };

  /** One subscriber's re-check. Never rejects. */
  const revalidateOne = async (
    sub: Subscriber<TDoc, TCtx>,
    memo: Map<string, unknown>,
  ): Promise<void> => {
    const revalidate = options.revalidate;
    if (!revalidate) return;
    let next: TCtx | ReplayCloseVerdict | null | undefined | false;
    try {
      next = await revalidate.check(sub.ctx, { memo });
    } catch (error) {
      counters.revalidateFailures++;
      sub.failures++;
      const limit = revalidate.maxConsecutiveFailures;
      if (limit !== undefined && sub.failures >= limit) {
        log.warn(
          `revalidate check threw ${sub.failures} times in a row; closing with retry`,
          error,
        );
        retrySub(sub, "revalidate_failed");
        return;
      }
      log.warn("revalidate check threw; stream kept open", error);
      return;
    }
    sub.failures = 0;
    if (sub.closed) return;
    // Fail closed: a check that forgot to return a ctx ends access, it does not keep it.
    if (next === null || next === undefined || next === false) {
      revokeSub(sub, "access_ended");
      return;
    }
    if (isCloseVerdict(next)) {
      if (next.close === "retry") retrySub(sub, next.reason ?? "retry");
      else revokeSub(sub, next.reason ?? "access_ended");
      return;
    }
    let key: string;
    try {
      key = JSON.stringify(readScope(next));
    } catch (error) {
      log.error("readScope threw for a revalidated ctx; closing the stream", error);
      sub.stream.close();
      return;
    }
    sub.ctx = next;
    // A ctx that reads a different partition cannot be re-homed mid-stream without a
    // gap; close and let the client resume into the right one. Compared with the key
    // fixed at attach, so a subscriber still attaching is covered too.
    if (key !== sub.scopeKey) sub.stream.close();
  };

  function revalidateTick(): void {
    if (!options.revalidate) return;
    const memo = new Map<string, unknown>();
    for (const sub of [...subscribers]) {
      if (sub.closed || sub.revalidating) continue;
      sub.revalidating = true;
      void revalidateOne(sub, memo).finally(() => {
        sub.revalidating = false;
      });
    }
  }

  // ---------------------------------------------------------------- revoke

  const revokeLocal = (
    matches: (sub: Subscriber<TDoc, TCtx>) => boolean,
    reason: string,
  ): number => {
    let n = 0;
    for (const sub of [...subscribers]) {
      if (sub.closed || !matches(sub)) continue;
      revokeSub(sub, reason);
      n++;
    }
    return n;
  };

  /** `identify(ctx)` with every value as a string (ObjectIds and numbers included). */
  const identityOf = (sub: Subscriber<TDoc, TCtx>): Record<string, string> | undefined => {
    let raw: RevokeTarget | undefined;
    try {
      raw = options.identify?.(sub.ctx);
    } catch (error) {
      log.error("identify threw; subscriber not matched for revoke", error);
      return undefined;
    }
    if (!raw) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw) as Array<[string, unknown]>) {
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" && !warnedNonStringIdentity) {
        warnedNonStringIdentity = true;
        log.warn(`identify returned a ${typeof v} for '${k}'; revoke compares String(value)`);
      }
      out[k] = String(v);
    }
    return out;
  };

  const matchesTarget = (target: Readonly<Record<string, unknown>>) => {
    const entries = Object.entries(target)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)] as const);
    return (sub: Subscriber<TDoc, TCtx>): boolean => {
      if (entries.length === 0) return false;
      const id = identityOf(sub);
      if (!id) return false;
      return entries.every(([k, v]) => id[k] === v);
    };
  };

  const events = (): EventsFacade | undefined =>
    (fastify as unknown as { events?: EventsFacade }).events;

  if (revokeType && sealer) {
    fastify.addHook("onReady", async () => {
      const bus = events();
      if (!bus) {
        throw new Error(
          "createReplayHub: `revokeVia` broadcasts over `fastify.events`, but arc's events plugin is not registered.",
        );
      }
      revokeUnsub = await bus.subscribe(revokeType, (event) => {
        const msg = sealer.open(event.payload);
        if (!msg || msg.origin === origin) return;
        revokeLocal(matchesTarget(msg.keys), msg.reason);
      });
    });
  }

  // ---------------------------------------------------------------- lifecycle

  registerSseStats(fastify, () => ({ connections: subscribers.size, keys: 0 }));

  const close = (): void => {
    if (hubClosed) return;
    hubClosed = true;
    for (const sub of [...subscribers]) {
      sub.stream.close();
      detach(sub);
    }
    partitions.clear();
    if (pollTimer !== undefined) timers.clearInterval(pollTimer);
    if (revalidateTimer !== undefined) timers.clearInterval(revalidateTimer);
    pollTimer = undefined;
    revalidateTimer = undefined;
    revokeUnsub?.();
    revokeUnsub = undefined;
  };

  fastify.addHook("onClose", async () => close());

  const handleOf = (sub: Subscriber<TDoc, TCtx>): ReplaySubscription<TCtx> => ({
    get ctx() {
      return sub.ctx;
    },
    get closed() {
      return sub.closed;
    },
    close() {
      if (sub.closed) return;
      sub.stream.close();
      detach(sub);
    },
  });

  /** Read the gap after `from`; `undefined` = more than `maxReplay` entries. */
  const readGap = async (
    from: string,
    scope: ReplayReadScope,
  ): Promise<ChangeEntry<TDoc>[] | undefined> => {
    const out: ChangeEntry<TDoc>[] = [];
    let cursor = from;
    for (;;) {
      const limit = Math.min(PAGE_LIMIT, maxReplay + 1 - out.length);
      const page = await store.since(cursor, { ...scope, limit });
      out.push(...page.changes);
      if (out.length > maxReplay) return undefined;
      if (!page.hasMore || page.changes.length === 0) return out;
      cursor = page.cursor;
    }
  };

  const attach = async (
    stream: SseStream,
    ctx: TCtx,
    lastEventId: string | null,
  ): Promise<ReplaySubscription<TCtx>> => {
    const sub: Subscriber<TDoc, TCtx> = {
      stream,
      ctx,
      scopeKey: undefined,
      partition: undefined,
      buffer: [],
      skip: null,
      floor: null,
      unsent: null,
      closed: false,
      revalidating: false,
      failures: 0,
    };
    const handle = handleOf(sub);
    if (hubClosed) {
      sub.closed = true;
      stream.close();
      return handle;
    }
    // Registered BEFORE any await: a disconnect mid-attach must still detach.
    stream.onCleanup(() => detach(sub));
    subscribers.add(sub);
    ensureTimers();

    try {
      const scope = readScope(ctx);
      // Fixed before the first await: a revalidation landing mid-attach compares to it.
      sub.scopeKey = JSON.stringify(scope);
      const p = partitionFor(scope, sub.scopeKey);
      let head: string | undefined;
      try {
        await p.ready;
        if (!sub.closed) head = await join(p, sub);
      } finally {
        p.pending--;
        if (sub.closed || head === undefined) dropIfIdle(p);
      }
      if (sub.closed || head === undefined) return handle;

      let reason: ResyncReason | undefined;
      let replay: ChangeEntry<TDoc>[] = [];
      if (lastEventId !== null) {
        if (options.isValidCursor && !options.isValidCursor(lastEventId)) {
          reason = "cursor_invalid";
        } else if (compareCursors && compareCursors(lastEventId, head) > 0) {
          reason = "cursor_invalid";
        } else {
          try {
            const gap = await readGap(lastEventId, scope);
            if (gap === undefined) reason = "gap_too_large";
            else replay = gap;
          } catch (error) {
            if (!isCursorExpired(error)) throw error;
            reason = "cursor_expired";
          }
        }
      }
      if (sub.closed) return handle;

      const resumed = lastEventId !== null && reason === undefined;
      writeControl(sub, STREAM_FRAMES.READY, { cursor: head, resumed } satisfies ReadyFrame);
      if (reason) {
        counters.resyncs++;
        writeControl(sub, STREAM_FRAMES.RESYNC, { cursor: head, reason } satisfies ResyncFrame);
      } else if (lastEventId !== null) {
        // Paced by the socket: a gap of megabytes waits for `drain` between frames
        // instead of overrunning the stream's buffer (live entries keep buffering).
        for (const entry of replay) {
          if (backpressured(sub) && !(await drained(sub))) return handle;
          writeEntry(sub, entry);
          if (sub.closed) return handle;
        }
        counters.replayed += replay.length;
        // The replay read to the END of the log, past `head`: the tail will offer
        // those entries again. Remember what was sent so they go out once.
        if (compareCursors) sub.floor = replay.at(-1)?.cursor ?? lastEventId;
        else if (replay.length > 0) sub.skip = new Set(replay.map((e) => e.cursor));
      }
      // Flush what the tail delivered meanwhile, minus what the replay already sent,
      // then go live.
      await flush(sub);
    } catch (error) {
      log.warn(
        "change-log read failed while attaching a stream; closing it for the client to retry",
        error,
      );
      stream.close();
      detach(sub);
    }
    return handle;
  };

  return {
    attach,
    notify(): void {
      if (notifyQueued || hubClosed) return;
      notifyQueued = true;
      queueMicrotask(() => {
        notifyQueued = false;
        pullAll();
      });
    },
    async revoke(target, reason = "revoked"): Promise<number> {
      const n = revokeLocal(matchesTarget(target), reason);
      const bus = revokeType && sealer ? events() : undefined;
      if (bus && revokeType && sealer) {
        const keys: Record<string, string> = {};
        for (const [k, v] of Object.entries(target) as Array<[string, unknown]>) {
          if (v !== undefined && v !== null) keys[k] = String(v);
        }
        await bus.publish(revokeType, sealer.seal({ origin, reason, keys }));
      }
      return n;
    },
    stats: () => ({
      subscribers: subscribers.size,
      partitions: partitions.size,
      ...counters,
    }),
    close,
  };
}
