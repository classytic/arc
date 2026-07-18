/**
 * Fetch-compatible BUFFERED request/response adapter for Fastify.
 *
 * Converts a Fastify app into a Web Standards `fetch` handler for
 * Lambda-style serverless runtimes:
 * - Cloudflare Workers (with `nodejs_compat` flag)
 * - Vercel Serverless Functions (Node.js runtime)
 * - AWS Lambda (via fetch-based adapters)
 * - Any runtime supporting the Web Standards Request/Response API
 *
 * Uses Fastify's `.inject()` internally — no TCP server, no `app.listen()`.
 *
 * **What this is NOT — a general edge transport.** `.inject()` buffers both
 * sides of the exchange, so the following are UNSUPPORTED by construction:
 * - SSE / streaming responses (the full body is buffered before returning)
 * - WebSocket upgrades (no socket exists)
 * - Backpressure across the adapter (both directions are fully buffered)
 * - Unbounded request/response sizes (see `maxRequestBytes`)
 *
 * It's the right shape for JSON APIs on serverless. For realtime at the
 * edge, publish events to a dedicated Worker/Durable-Object edge tier
 * instead of routing sockets through this adapter.
 *
 * @example Cloudflare Workers
 * ```typescript
 * import { createApp } from '@classytic/arc/factory';
 * import { toFetchHandler } from '@classytic/arc/factory/edge';
 *
 * const app = await createApp({
 *   preset: 'edge',
 *   auth: { type: 'jwt', jwt: { secret: env.JWT_SECRET } },
 * });
 * await app.register(productResource.toPlugin());
 *
 * export default { fetch: toFetchHandler(app) };
 * ```
 *
 * @example Vercel Serverless Function
 * ```typescript
 * const handler = toFetchHandler(app);
 * export const GET = handler;
 * export const POST = handler;
 * ```
 *
 * **Important:** Requires `nodejs_compat` flag on Cloudflare Workers for
 * `node:crypto` and `AsyncLocalStorage` support.
 */

import type { FastifyInstance } from "fastify";

export interface FetchHandlerOptions {
  /**
   * Whether to call `app.ready()` on the first request.
   * Set to `false` if you've already called it during module init.
   * @default true
   */
  autoReady?: boolean;
  /**
   * Reject request bodies larger than this many bytes with 413
   * `arc.payload_too_large`. Enforcement precision matters: bodies with a
   * declared `Content-Length` are rejected BEFORE buffering; chunked or
   * undeclared bodies are necessarily buffered first and checked AFTER
   * (`arrayBuffer()` allocates the full body — a consequence of the
   * buffered-adapter design, not a bug). Platform/gateway body limits
   * remain the real pre-allocation protection for hostile senders.
   * Fastify's own `bodyLimit` still applies after this gate. Set to `0`
   * to disable the gate.
   * @default 1_048_576 (1 MiB — matches Fastify's default bodyLimit)
   */
  maxRequestBytes?: number;
}

/**
 * Convert a Fastify app into a Web Standards fetch handler.
 *
 * The returned function accepts a Web Standard `Request` and returns
 * a Web Standard `Response` — the universal serverless contract.
 *
 * Internally uses `app.inject()` which processes the request through
 * the full Fastify pipeline (hooks, plugins, routes) without TCP.
 * Bodies are read as raw bytes (`arrayBuffer()`), so binary payloads
 * (protobuf, images, non-UTF-8 charsets) survive intact — the
 * content-type parser decides how to decode, same as a real socket.
 */
export function toFetchHandler(
  app: FastifyInstance,
  options: FetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const { autoReady = true, maxRequestBytes = 1_048_576 } = options;
  // ONE shared readiness promise — concurrent cold-start requests all await
  // the same boot instead of racing a boolean (the second request must not
  // dispatch before plugins finish registering).
  let readyPromise: Promise<unknown> | null = null;

  return async (request: Request): Promise<Response> => {
    if (autoReady) {
      // `app.ready()` returns a thenable FastifyInstance — wrap it so the
      // cached value is a plain promise.
      readyPromise ??= Promise.resolve(app.ready());
      await readyPromise;
    }

    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Cheap pre-buffer gate when the sender declares a length. Chunked
    // bodies (no content-length) are caught by the post-buffer check below.
    if (maxRequestBytes > 0) {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxRequestBytes) {
        return payloadTooLarge(maxRequestBytes);
      }
    }

    // Read body as raw bytes — `text()` would decode as UTF-8 and corrupt
    // binary payloads. Fastify's content-type parsers receive the Buffer
    // and decode per their own `parseAs` contract, same as over TCP.
    let payload: Buffer | undefined;
    if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
      const bytes = await request.arrayBuffer();
      if (maxRequestBytes > 0 && bytes.byteLength > maxRequestBytes) {
        return payloadTooLarge(maxRequestBytes);
      }
      if (bytes.byteLength > 0) payload = Buffer.from(bytes);
    }

    const response = await app.inject({
      method: request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
      url: url.pathname + url.search,
      headers,
      ...(payload ? { payload } : {}),
    });

    // Convert Fastify response headers to Headers object
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) responseHeaders.append(key, v);
      } else {
        responseHeaders.set(key, String(value));
      }
    }

    // `rawPayload` preserves binary response bodies byte-for-byte;
    // `response.payload` is a UTF-8 string view of the same buffer.
    return new Response(response.rawPayload, {
      status: response.statusCode,
      headers: responseHeaders,
    });
  };
}

/** Canonical ErrorContract shape for the pre-dispatch 413. */
function payloadTooLarge(limit: number): Response {
  return new Response(
    JSON.stringify({
      code: "arc.payload_too_large",
      message: `Request body exceeds ${limit} bytes`,
      status: 413,
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}
