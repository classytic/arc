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
 *   - backpressure fail-fast: a full socket buffer DESTROYS the connection
 *     instead of queueing unbounded memory behind a slow client / L7 proxy
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
}

export interface SseStream {
  /**
   * Write one SSE frame. `id` (optional) becomes the standard SSE `id:`
   * field — clients receive it as `lastEventId` (WHATWG), enabling
   * client-side dedup/resume bookkeeping even when the server keeps no
   * replay log. Returns `false` when the connection was destroyed
   * (backpressure) — the stream is already cleaned up; stop writing.
   */
  write(eventName: string, data: string, id?: string): boolean;
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
  const { heartbeatMs = 30_000, retryMs } = options;

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

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
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
    // TCP backpressure / slow client: terminate instead of buffering
    // unbounded memory behind L7 proxies.
    request.raw.destroy(new Error(`SSE connection terminated: ${context} backpressure`));
    close();
  };

  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    const ok = reply.raw.write(": heartbeat\n\n");
    if (!ok) destroyOnBackpressure("heartbeat");
  }, heartbeatMs);

  // Cleanup on client disconnect
  request.raw.on("close", close);

  return {
    write(eventName, data, id) {
      if (closed) return false;
      const idField = id !== undefined ? `id: ${id}\n` : "";
      const ok = reply.raw.write(`${idField}event: ${eventName}\ndata: ${data}\n\n`);
      if (!ok) {
        destroyOnBackpressure("slow client");
        return false;
      }
      return true;
    },
    close,
    onCleanup(fn) {
      cleanups.push(fn);
    },
  };
}
