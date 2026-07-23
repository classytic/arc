/**
 * Request ID Plugin
 *
 * Propagates request IDs for distributed tracing.
 * - Accepts incoming x-request-id header (sanitized)
 * - Generates UUID if not provided
 * - Echoes the id on the response header + W3C trace-context propagation
 *
 * ID RESOLUTION LIVES AT THE SERVER LEVEL, NOT HERE. Fastify binds
 * `request.log = logger.child({ reqId: request.id })` at request
 * construction — before any hook runs — so an id assigned inside a hook
 * never reaches the logs. `createApp` therefore wires
 * {@link createRequestIdGenerator} into Fastify's `genReqId` option, and
 * this plugin simply adopts `request.id`. Standalone registration on a
 * bare Fastify instance falls back to the legacy in-hook resolution
 * (header echo / UUID), with the documented limitation that
 * `request.log`'s `reqId` binding predates the overwrite — pass
 * `genReqId: createRequestIdGenerator()` to `Fastify()` to fix that.
 *
 * @example
 * import { requestIdPlugin, createRequestIdGenerator } from '@classytic/arc';
 *
 * const fastify = Fastify({ genReqId: createRequestIdGenerator() });
 * await fastify.register(requestIdPlugin);
 *
 * fastify.get('/', async (request) => {
 *   request.log.info('traced');   // carries the same reqId as the header
 *   return { id: request.id };
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

/**
 * Sanitize an incoming request-id header value: max 128 chars, alphanumeric
 * plus dashes/underscores/dots/colons only. Returns `undefined` for anything
 * else (crafted values could pollute logs or response headers). Array values
 * (repeated headers) are rejected outright — a client sending multiple
 * request-id headers is not tracing in good faith.
 */
export function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 && /^[\w.:-]+$/.test(trimmed)
    ? trimmed
    : undefined;
}

/**
 * Build a Fastify `genReqId` function: adopt a sanitized incoming request-id
 * header, or generate one. Wire this into the `Fastify()` constructor so
 * `request.id`, `request.log`'s `reqId` binding, and the echoed response
 * header all agree — `createApp` does this automatically.
 */
export function createRequestIdGenerator(
  opts: Pick<RequestIdOptions, "header" | "generator"> = {},
): (req: { headers: Record<string, string | string[] | undefined> }) => string {
  const { header = "x-request-id", generator = randomUUID } = opts;
  const headerName = header.toLowerCase();
  return (req) => sanitizeRequestId(req.headers[headerName]) ?? generator();
}

/** Fastify's default request ids are `req-<base36 counter>`. */
const FASTIFY_DEFAULT_ID = /^req-[0-9a-z]+$/;

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

  // Echo the request ID + propagate trace context on each request.
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
    const incoming = sanitizeRequestId(request.headers[header]);
    let requestId = String(request.id);

    // Under createApp, `genReqId` (createRequestIdGenerator) already
    // resolved `request.id` from the same header/sanitizer, so both
    // branches below are no-ops and — critically — `request.log`'s
    // `reqId` binding matches the echoed header. They fire only for
    // STANDALONE registration on a bare Fastify instance, preserving the
    // legacy contract (sanitized header echoed, UUID otherwise) with the
    // documented limitation that the log binding predates the overwrite.
    if (incoming && incoming !== requestId) {
      requestId = incoming;
    } else if (!incoming && FASTIFY_DEFAULT_ID.test(requestId)) {
      requestId = generator();
    }
    if (requestId !== request.id) {
      (request as { id: string }).id = requestId;
    }
    request.requestId = requestId;

    if (setResponseHeader) {
      reply.header(header, requestId);
    }

    // W3C Trace Context propagation.
    // Parse and validate `traceparent` (required) and `tracestate` (optional).
    // Both are forwarded in the response so downstream hops can continue the trace.
    if (propagateTraceContext) {
      const rawTraceparent = request.headers.traceparent;
      const rawTracestate = request.headers.tracestate;

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
