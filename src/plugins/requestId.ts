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
  /**
   * Whether to read and forward W3C Trace Context headers (`traceparent`,
   * `tracestate`). When enabled, valid incoming headers are stored in
   * `request.traceContext` and echoed in the response. Default: `true`.
   */
  propagateTraceContext?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Unique request identifier for tracing */
    requestId: string;
    /**
     * W3C Trace Context parsed from the incoming `traceparent` header.
     * `undefined` when the header was absent or malformed.
     */
    traceContext?: { traceparent: string; tracestate?: string };
  }
}

/** W3C traceparent format: `version-traceid-parentid-flags` */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
/** W3C spec: version ff is reserved and invalid; trace/parent IDs must not be all zeros */
const TRACEID_ZEROS = "0".repeat(32);
const PARENTID_ZEROS = "0".repeat(16);
/** tracestate: printable ASCII, <= 512 bytes */
const TRACESTATE_MAX = 512;

function isValidTraceparent(tp: string): boolean {
  const m = TRACEPARENT_RE.exec(tp);
  if (!m) return false;
  // Capture groups are guaranteed by the regex match, but under
  // `noUncheckedIndexedAccess` they are typed `string | undefined`.
  const version = m[1] ?? "";
  const traceId = m[2] ?? "";
  const parentId = m[3] ?? "";
  // version ff is reserved and MUST be rejected (spec §3.2.1)
  if (version.toLowerCase() === "ff") return false;
  // all-zero trace/parent IDs are invalid (spec §3.2.2 / §3.2.3)
  if (traceId.toLowerCase() === TRACEID_ZEROS) return false;
  if (parentId.toLowerCase() === PARENTID_ZEROS) return false;
  return true;
}

const requestIdPlugin: FastifyPluginAsync<RequestIdOptions> = async (
  fastify: FastifyInstance,
  opts: RequestIdOptions = {},
) => {
  const {
    header = "x-request-id",
    generator = randomUUID,
    setResponseHeader = true,
    propagateTraceContext = true,
  } = opts;

  // Decorate request with requestId and traceContext
  if (!fastify.hasRequestDecorator("requestId")) {
    fastify.decorateRequest("requestId", "");
  }
  if (!fastify.hasRequestDecorator("traceContext")) {
    fastify.decorateRequest("traceContext", undefined);
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

    // W3C Trace Context propagation.
    // Parse and validate `traceparent` (required) and `tracestate` (optional).
    // Both are forwarded in the response so downstream hops can continue the trace.
    if (propagateTraceContext) {
      const rawTraceparent = request.headers["traceparent"];
      const rawTracestate = request.headers["tracestate"];

      if (typeof rawTraceparent === "string") {
        const tp = rawTraceparent.trim();
        if (isValidTraceparent(tp)) {
          const ts =
            typeof rawTracestate === "string" &&
            rawTracestate.length > 0 &&
            rawTracestate.length <= TRACESTATE_MAX
              ? rawTracestate
              : undefined;

          request.traceContext = { traceparent: tp, ...(ts ? { tracestate: ts } : {}) };
          reply.header("traceparent", tp);
          if (ts) reply.header("tracestate", ts);
        }
      }
    }
  });

  fastify.log?.debug?.("Request ID plugin registered");
};

export default fp(requestIdPlugin, {
  name: "arc-request-id",
  fastify: "5.x",
});

export { requestIdPlugin };
