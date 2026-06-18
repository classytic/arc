/**
 * Streaming helpers — adapters between Web `ReadableStream` producers
 * (Vercel AI SDK, OpenAI SDK, `fetch().body`, hand-built `TransformStream`s)
 * and Fastify's raw Node-stream reply.
 *
 * Why this exists: returning a `ReadableStream<UIMessageChunk>` from a
 * `streamResponse: true` arc route used to crash with
 * `chunk must be a string or Buffer` because Fastify cannot serialise
 * `UIMessageChunk` JSON objects directly. Every arc-ai host (sniffer,
 * spawn, downstream) reimplemented the same `JsonToSseTransformStream` +
 * SSE header boilerplate. `pipeUIMessageStreamToReply()` is that
 * boilerplate, owned once.
 *
 * arc stays peer-coupled to nothing: the helper accepts any
 * `ReadableStream<unknown>` and JSON-stringifies each chunk. It works
 * with `UIMessageChunk` from the AI SDK without importing it.
 */

import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Canonical SSE headers for AI-SDK-style UI message streams.
 *
 * `x-vercel-ai-ui-message-stream: v1` is the marker the Vercel AI SDK
 * client uses to detect the v1 UI message stream protocol (vs the older
 * data stream protocol). Surfaced as a constant so hosts don't memorise it.
 */
export const UI_MESSAGE_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "x-vercel-ai-ui-message-stream": "v1",
} as const;

export interface PipeUIMessageStreamOptions {
  /**
   * Headers to send before the first chunk. Defaults to
   * {@link UI_MESSAGE_STREAM_HEADERS}. Pass a fully-replaced bag when
   * you need a different protocol marker; merge manually otherwise —
   * the helper does not deep-merge to keep behaviour predictable.
   */
  headers?: Record<string, string>;
  /**
   * Abort signal — when fired, the helper cancels the source stream and
   * ends the reply early. `request.raw` `close` is wired automatically
   * when {@link pipeUIMessageStreamToReply} sees `reply.request`, so most
   * hosts never pass this directly.
   */
  signal?: AbortSignal;
  /**
   * Custom chunk serialiser. Default: `JSON.stringify(chunk)`. Override
   * when chunks are already strings (rare — most AI SDK transforms emit
   * objects) or when you need pretty-print / type-prefix shenanigans.
   */
  serialize?: (chunk: unknown) => string;
}

/**
 * Pipe a Web `ReadableStream` of JSON-serialisable chunks (typically
 * `UIMessageChunk` from the Vercel AI SDK) into a Fastify reply as an
 * SSE event stream.
 *
 * - Sets {@link UI_MESSAGE_STREAM_HEADERS} (or the caller's override)
 *   before the first chunk.
 * - Writes each chunk as `data: ${JSON.stringify(chunk)}\n\n`.
 * - Cancels the source and closes the reply when the client disconnects.
 * - Resolves once the stream is fully written.
 *
 * @example
 * ```ts
 * import { pipeUIMessageStreamToReply } from '@classytic/arc/utils';
 * import { streamText, convertToUIMessageStream } from 'ai';
 *
 * defineResource({
 *   name: 'chat',
 *   routes: [{
 *     method: 'POST', path: '/', streamResponse: true,
 *     handler: async (req, reply) => {
 *       const result = streamText({ model, messages: req.body.messages });
 *       await pipeUIMessageStreamToReply(reply, result.toUIMessageStream());
 *     },
 *   }],
 * });
 * ```
 */
export async function pipeUIMessageStreamToReply(
  reply: FastifyReply,
  stream: ReadableStream<unknown>,
  options: PipeUIMessageStreamOptions = {},
): Promise<void> {
  const serialize = options.serialize ?? defaultSerialize;

  // Set SSE headers via `reply.header()` so Fastify's response lifecycle
  // (hooks like @fastify/cors's `onSend`) runs and merges its headers in.
  // Writing to `reply.raw` directly with `raw.flushHeaders()` bypasses
  // the onSend chain and silently drops cross-origin / auth / cookie
  // headers contributed by plugins.
  const headers = options.headers ?? UI_MESSAGE_STREAM_HEADERS;
  for (const [key, value] of Object.entries(headers)) {
    reply.header(key, value);
  }

  // Wire client-disconnect → reader.cancel() so the upstream producer
  // (LLM call, DB cursor) stops promptly instead of running to completion
  // on a dead socket. Cache the listener ref so we can remove it from
  // BOTH sources — leaking an abort listener on a long-lived
  // `AbortSignal` would pin the closure indefinitely.
  const reader = stream.getReader();
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    reader.cancel().catch(() => {
      /* already cancelled */
    });
  };
  reply.request.raw.once("close", onAbort);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  // Async iterable that yields SSE frames; `Readable.from()` wraps it as
  // a Node stream Fastify can hand to `reply.send()`. Wrapping (vs writing
  // to `reply.raw` directly) lets Fastify run its full response lifecycle
  // — preSerialization → onSend → serializer — so plugin-contributed
  // headers (CORS, security, cookies) survive on the wire.
  async function* sseFrames(): AsyncGenerator<string, void, undefined> {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        yield `data: ${serialize(value)}\n\n`;
      }
    } catch (err) {
      // Surface as a final SSE error frame so the client sees a structured
      // failure instead of a half-closed connection. Mirrors how Vercel AI
      // SDK's reference servers handle pipe failures.
      //
      // We don't re-throw: `Readable.from()` would destroy the Node stream
      // on a generator throw, which Fastify surfaces as
      // "response destroyed before completion" — and the error frame
      // wouldn't reach the wire. Emit + return cleanly instead.
      if (!cancelled) {
        yield `event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`;
      }
    } finally {
      reply.request.raw.removeListener("close", onAbort);
      options.signal?.removeEventListener("abort", onAbort);
      reader.releaseLock?.();
    }
  }

  const nodeStream = Readable.from(sseFrames());
  await reply.send(nodeStream);
}

function defaultSerialize(chunk: unknown): string {
  return typeof chunk === "string" ? chunk : JSON.stringify(chunk);
}

// ============================================================================
// SSE auth + CORS helpers (browser EventSource ergonomics)
// ============================================================================

/**
 * Promote a stream auth token from the query string into the `Authorization`
 * header, in place, so the standard `fastify.authenticate` decorator can read it.
 *
 * Why: the browser `EventSource` (and `WebSocket`) API **cannot set request
 * headers** — there is no header channel on the constructor. So arc-next's
 * `buildStreamUrl` (bearer mode) appends the token as `?token=<jwt>` on stream
 * URLs. Server auth reads the `Authorization` header, so without this promotion
 * EVERY browser SSE/WS stream is 401 in bearer mode (cookie mode is unaffected —
 * arc-next omits the query token there and relies on the cookie).
 *
 * Safe by construction:
 * - No-op when an `Authorization` header is already present → normal `fetch`
 *   requests (which send the header) are never touched.
 * - The token still goes through full authentication downstream, so a forged or
 *   stale value simply 401s. This only relocates WHERE the bearer is read from;
 *   it grants no trust on its own.
 *
 * Parsed from `request.raw.url` (not `request.query`) so it's robust to route
 * querystring schemas that would otherwise strip an undeclared `token` param.
 *
 * @param queryParam name of the query parameter carrying the token (default `token`).
 */
export function promoteStreamTokenToHeader(request: FastifyRequest, queryParam = "token"): void {
  if (request.headers.authorization) return;
  const url = request.raw.url ?? "";
  const q = url.indexOf("?");
  if (q < 0) return;
  const token = new URLSearchParams(url.slice(q + 1)).get(queryParam);
  if (token) request.headers.authorization = `Bearer ${token}`;
}

/**
 * Collect the CORS / `Vary` headers a plugin (e.g. `@fastify/cors`, whose default
 * `onRequest` hook runs BEFORE the route handler) has already set on the reply, so
 * a hijacked SSE handler that writes straight to `reply.raw.writeHead(...)` can
 * merge them onto the raw response.
 *
 * Why: `reply.hijack()` + `reply.raw.writeHead()` bypass Fastify's `onSend`
 * serialization, which is where reply-level headers reach the wire. A cross-origin
 * `EventSource` therefore receives no `Access-Control-Allow-Origin` and the browser
 * blocks the (authenticated) stream. Re-emitting the already-computed CORS headers
 * honors the host's configured policy (origin allowlist, credentials) rather than
 * re-deriving it. Returns lowercased header names suitable for `writeHead`.
 */
export function forwardedStreamHeaders(reply: FastifyReply): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value == null) continue;
    if (key.startsWith("access-control-") || key === "vary") {
      out[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return out;
}

/**
 * Heuristic — does this value look like a Web `ReadableStream`?
 *
 * Used by `createCrudRouter` to auto-pipe `streamResponse: true` handlers
 * that return a UI message stream instead of writing to `reply.raw`
 * directly. Cross-realm safe (no `instanceof`) — checks the duck shape
 * the Streams spec mandates: `getReader`, `cancel`, and the `locked`
 * getter.
 */
export function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  if (value === null || typeof value !== "object") return false;
  const obj = value as { getReader?: unknown; cancel?: unknown; locked?: unknown };
  return (
    typeof obj.getReader === "function" &&
    typeof obj.cancel === "function" &&
    typeof obj.locked === "boolean"
  );
}
