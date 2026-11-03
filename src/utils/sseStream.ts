/**
 * SSE transport primitive — the delicate socket mechanics every SSE-shaped
 * arc plugin shares, extracted from the sse plugin (2.22) so realtime
 * doesn't re-learn its lessons:
 *
 *   - `reply.hijack()` + raw `writeHead` (bypasses the onSend chain, so
 *     CORS/Vary headers @fastify/cors queued earlier are merged in via
 *     `forwardedStreamHeaders` — without this a cross-origin EventSource
 *     gets blocked)
 *   - `x-accel-buffering: no` (nginx would otherwise buffer the stream)
 *   - bounded backpressure: a full socket buffer (Node's writable high-water
 *     mark, 16 KiB by default) is NOT a slow client by itself — a burst on a
 *     fast client passes it too. The stream waits for `drain` within a byte
 *     budget (`maxBufferedBytes`) and a time budget (`drainTimeoutMs`) and
 *     destroys the connection only when either is exceeded, so memory stays
 *     bounded behind a slow client / L7 proxy. Writers that can pace
 *     themselves read `needsDrain` and await `drain()`.
 *   - heartbeat comments to keep intermediaries from idling the socket
 *   - single idempotent cleanup wired to client disconnect
 *
 * Callers get `{ write, close }` and register teardown via `onCleanup` —
 * every other concern (auth, filtering, what to write) stays theirs.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { forwardedStreamHeaders } from "./streaming.js";

export interface SseStreamOptions {
  /** Heartbeat comment interval in ms (default: 30000). */
  heartbeatMs?: number;
  /**
   * Reconnection-delay hint written once at connect as the standard SSE
   * `retry:` field (WHATWG EventSource honors it natively). Omit to send
   * no hint (browser default ~3s).
   */
  retryMs?: number;
  /**
   * Bytes a client may leave unread in the response buffer before the
   * connection is destroyed. Checked whenever a write finds the buffer full,
   * against the bytes queued before that write, so a single frame larger than
   * the budget still reaches a client that reads.
   * Default 1 MiB. `0` restores the fail-fast rule of arc 2.48 and earlier:
   * the first write that finds the buffer full destroys the connection.
   */
  maxBufferedBytes?: number;
  /**
   * How long a full buffer may wait for the socket's `drain` before the
   * connection is destroyed, in ms. Default 10000.
   */
  drainTimeoutMs?: number;
}

/** Default {@link SseStreamOptions.maxBufferedBytes}: 1 MiB. */
export const SSE_DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
/** Default {@link SseStreamOptions.drainTimeoutMs}: 10 s. */
export const SSE_DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export interface SseStream {
  /**
   * Write one SSE frame. `id` (optional) becomes the standard SSE `id:`
   * field — clients receive it as `lastEventId` (WHATWG), enabling
   * client-side dedup/resume bookkeeping even when the server keeps no
   * replay log. Returns `false` when the stream is closed or the write
   * exceeded the backpressure budget (the connection was destroyed and the
   * stream is already cleaned up; stop writing). `true` means the frame was
   * accepted, possibly into the buffer: check {@link needsDrain} to pace a burst.
   */
  write(eventName: string, data: string, id?: string): boolean;
  /**
   * Write an id-only frame (`id: <id>` and no `data:`). Under the WHATWG SSE
   * rules it moves the client's `lastEventId` without firing an event, so a
   * reconnect resumes after entries this client was not shown. Optional so a
   * host's own `SseStream` double still type-checks; `openSseStream` has it.
   * Same return contract as {@link write}.
   */
  writeId?(id: string): boolean;
  /**
   * `true` while the socket buffer is full and the stream waits for `drain`.
   * A writer with a burst (a replay) awaits {@link drain} before writing more,
   * so the burst never exceeds the byte budget. Optional so a host's own
   * `SseStream` double still type-checks; `openSseStream` has it.
   */
  readonly needsDrain?: boolean;
  /**
   * Resolves `true` once the buffer has drained (at once when it is not full),
   * `false` when the stream closed first (destroyed after `drainTimeoutMs`, the
   * client left, or `close()`). Optional for the same reason as {@link needsDrain}.
   */
  drain?(): Promise<boolean>;
  /** Idempotent teardown: heartbeat cleared, cleanups run, socket ended. */
  close(): void;
  /** Register teardown work (unsubscribes etc.) — runs exactly once. */
  onCleanup(fn: () => void): void;
}

/**
 * Take over the reply socket and open an SSE stream. Call ONLY after every
 * gate (auth, permissions, validation) has passed — after `hijack()` no
 * JSON error can be sent.
 */
export function openSseStream(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SseStreamOptions = {},
): SseStream {
  const {
    heartbeatMs = 30_000,
    retryMs,
    maxBufferedBytes = SSE_DEFAULT_MAX_BUFFERED_BYTES,
    drainTimeoutMs = SSE_DEFAULT_DRAIN_TIMEOUT_MS,
  } = options;
  // Checked before the hijack, so a bad value is still an ordinary 500.
  if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 0) {
    throw new Error(
      `openSseStream: maxBufferedBytes must be a number >= 0, got ${String(maxBufferedBytes)}.`,
    );
  }
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0) {
    throw new Error(
      `openSseStream: drainTimeoutMs must be a positive number, got ${String(drainTimeoutMs)}.`,
    );
  }

  // 1. Tell Fastify we are taking over the socket
  reply.hijack();

  // Set SSE headers and flush immediately so clients detect the connection.
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no", // Disable nginx buffering
    ...forwardedStreamHeaders(reply),
  });
  reply.raw.flushHeaders();
  if (retryMs !== undefined) {
    reply.raw.write(`retry: ${retryMs}\n\n`);
  }

  const cleanups: (() => void)[] = [];
  let closed = false;
  /** The last write found the buffer full; cleared by the socket's `drain`. */
  let needDrain = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let drainWaiters: Array<(drained: boolean) => void> = [];

  const settleDrainWaiters = (drained: boolean): void => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve(drained);
  };

  const onDrain = (): void => {
    if (!needDrain) return;
    needDrain = false;
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    drainTimer = undefined;
    settleDrainWaiters(true);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    drainTimer = undefined;
    reply.raw.off?.("drain", onDrain);
    settleDrainWaiters(false);
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // teardown is best-effort; one failing unsubscribe must not
        // strand the others
      }
    }
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  };

  const destroyOnBackpressure = (context: string): void => {
    // TCP backpressure / slow client past the budget: terminate instead of
    // buffering unbounded memory behind L7 proxies.
    request.raw.destroy(new Error(`SSE connection terminated: ${context} backpressure`));
    close();
  };

  /**
   * Write a chunk. A full buffer is tolerated within the byte budget while a
   * `drain` is awaited for at most `drainTimeoutMs`; past either budget the
   * connection is destroyed and `false` returned.
   */
  const send = (chunk: string, context: string): boolean => {
    if (closed) return false;
    // Judge the bytes the client left unread BEFORE this frame: the length
    // after the write includes the frame itself, so one frame larger than the
    // budget would destroy even a fast client (and a replay hub would resend
    // that frame on every reconnect).
    const prior = reply.raw.writableLength;
    if (reply.raw.write(chunk)) return true;
    if (maxBufferedBytes === 0 || (typeof prior === "number" && prior > maxBufferedBytes)) {
      destroyOnBackpressure(context);
      return false;
    }
    if (!needDrain) {
      needDrain = true;
      drainTimer = setTimeout(
        () => destroyOnBackpressure(`${context} (no drain within ${drainTimeoutMs} ms)`),
        drainTimeoutMs,
      );
      (drainTimer as { unref?: () => void }).unref?.();
    }
    return true;
  };

  reply.raw.on?.("drain", onDrain);

  const heartbeatTimer = setInterval(() => {
    // A full buffer is already being judged by the drain timer; a heartbeat
    // would only add bytes behind it.
    if (closed || needDrain) return;
    send(": heartbeat\n\n", "heartbeat");
  }, heartbeatMs);

  // Cleanup on client disconnect
  request.raw.on("close", close);

  return {
    write(eventName, data, id) {
      const idField = id !== undefined ? `id: ${id}\n` : "";
      return send(`${idField}event: ${eventName}\ndata: ${data}\n\n`, "slow client");
    },
    writeId(id) {
      return send(`id: ${id}\n\n`, "slow client");
    },
    get needsDrain() {
      return needDrain && !closed;
    },
    drain() {
      if (closed) return Promise.resolve(false);
      if (!needDrain) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => drainWaiters.push(resolve));
    },
    close,
    onCleanup(fn) {
      cleanups.push(fn);
    },
  };
}
