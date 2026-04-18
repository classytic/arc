/**
 * Reply state guards for onSend hooks.
 *
 * Every plugin that mutates headers in an `onSend` hook must short-circuit
 * when the reply is already committed — otherwise the subsequent
 * `reply.header()` call trips `ERR_HTTP_HEADERS_SENT` inside Fastify's
 * `safeWriteHead` after the hook resolves.
 *
 * In production (real HTTP server) the guard is a no-op: headers are never
 * committed before onSend fires. It exists to protect against test-harness
 * races under `light-my-request` (vitest + `app.inject()`) where an error
 * path / action route / 404 can flush headers before the onSend chain runs.
 */

import type { FastifyReply } from "fastify";

/**
 * True if the reply's headers are already flushed or send is in progress.
 * Use at the top of any onSend hook that mutates headers:
 *
 * ```ts
 * fastify.addHook("onSend", async (request, reply, payload) => {
 *   if (isReplyCommitted(reply)) return payload;
 *   reply.header("x-custom", "value");
 *   return payload;
 * });
 * ```
 */
export function isReplyCommitted(reply: FastifyReply): boolean {
  return reply.raw.headersSent || reply.sent;
}
