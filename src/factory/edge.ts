/**
 * Edge / Serverless Handler — Web Standards adapter for Fastify
 *
 * Converts a Fastify app into a Web Standards `fetch` handler that works in:
 * - Cloudflare Workers (with `nodejs_compat` flag)
 * - Vercel Edge Functions (Node.js compat mode)
 * - AWS Lambda (via fetch-based adapters)
 * - Any runtime supporting the Web Standards Request/Response API
 *
 * Uses Fastify's `.inject()` internally — no TCP server, no `app.listen()`.
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
 * @example Vercel Edge Function
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
}

/**
 * Convert a Fastify app into a Web Standards fetch handler.
 *
 * The returned function accepts a Web Standard `Request` and returns
 * a Web Standard `Response` — the universal serverless/edge contract.
 *
 * Internally uses `app.inject()` which processes the request through
 * the full Fastify pipeline (hooks, plugins, routes) without TCP.
 */
export function toFetchHandler(
  app: FastifyInstance,
  options: FetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const { autoReady = true } = options;
  let ready = false;

  return async (request: Request): Promise<Response> => {
    // Ensure Fastify is initialized on first request
    if (autoReady && !ready) {
      await app.ready();
      ready = true;
    }

    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Read body if present — inject() handles parsing based on content-type
    let payload: string | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        payload = await request.text();
      } catch {
        // No body — fine for DELETE etc.
      }
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

    return new Response(response.payload, {
      status: response.statusCode,
      headers: responseHeaders,
    });
  };
}
