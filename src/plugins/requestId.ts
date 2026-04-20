/**
 * Request ID Plugin
 *
 * Propagates request IDs for distributed tracing.
 * - Accepts incoming x-request-id header
 * - Generates UUID if not provided
 * - Attaches to request.id and response header
 *
 * @example
 * import { requestIdPlugin } from '@classytic/arc';
 *
 * await fastify.register(requestIdPlugin);
 *
 * // In handlers, access via request.id
 * fastify.get('/', async (request) => {
 *   console.log(request.id); // UUID
 * });
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export interface RequestIdOptions {
  /** Header name to read/write request ID (default: 'x-request-id') */
  header?: string;
  /** Custom ID generator (default: crypto.randomUUID) */
  generator?: () => string;
  /** Whether to set response header (default: true) */
  setResponseHeader?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Unique request identifier for tracing */
    requestId: string;
  }
}

const requestIdPlugin: FastifyPluginAsync<RequestIdOptions> = async (
  fastify: FastifyInstance,
  opts: RequestIdOptions = {},
) => {
  const { header = "x-request-id", generator = randomUUID, setResponseHeader = true } = opts;

  // Decorate request with requestId
  if (!fastify.hasRequestDecorator("requestId")) {
    fastify.decorateRequest("requestId", "");
  }

  // Assign request ID + set response header on each request.
  //
  // The `reply.header()` call is intentionally in onRequest, NOT onSend.
  // An async onSend hook races with Fastify's onSendEnd → safeWriteHead
  // path and produces ERR_HTTP_HEADERS_SENT unhandled rejections for
  // slow responses (same class of bug the caching.ts plugin fixes by
  // using preSerialization). onRequest has both request + reply
  // available, runs before any body is sent, and fires for EVERY
  // response — including 204 no-body and raw streams where
  // preSerialization would be skipped. The header is queued and
  // flushed with the response; no race window.
  fastify.addHook("onRequest", async (request, reply) => {
    const incomingId = request.headers[header];
    // Sanitize incoming ID: max 128 chars, alphanumeric + dashes/underscores/dots only.
    // Rejects crafted values that could pollute logs or headers.
    const sanitized = typeof incomingId === "string" ? incomingId.trim() : "";
    const isValid = sanitized.length > 0 && sanitized.length <= 128 && /^[\w.:-]+$/.test(sanitized);
    const requestId = isValid ? sanitized : generator();

    // Set on request object (Fastify's native id)
    (request as { id: string }).id = requestId;
    // Set on our decorated property
    request.requestId = requestId;

    if (setResponseHeader) {
      reply.header(header, requestId);
    }
  });

  fastify.log?.debug?.("Request ID plugin registered");
};

export default fp(requestIdPlugin, {
  name: "arc-request-id",
  fastify: "5.x",
});

export { requestIdPlugin };
