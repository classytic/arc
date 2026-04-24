/**
 * Unified WebSocket authentication helper.
 *
 * Collapses two previously-duplicated concerns into one function:
 *   1. Initial handshake auth (handshake → accept or reject connection)
 *   2. Periodic re-auth loop (revalidate live connection → disconnect if expired)
 *
 * Before the split, `websocket.ts` had two separate inline `fakeReply`
 * shims that were ~20 LOC each, typed as `any`, and subtly different
 * (different closures, separate `rejected` booleans, divergent swallow
 * strategies). That's exactly the kind of duplicated auth surface where a
 * regression hides — one shim gets hardened while the other drifts.
 *
 * The helper exports ONE boundary. Both call sites go through it.
 *
 * @classytic/arc type philosophy: this module does not take a typecheck-
 * time dependency on @fastify/websocket (the peer package has shifting
 * types across minors). Instead, the socket / request shapes are narrow
 * interface types defined here — they document the exact surface the
 * helper reads, not the full @fastify/websocket contract.
 */

import type { FastifyInstance } from "fastify";
import type { AuthResult, WebSocketPluginOptions } from "./types.js";

/**
 * Minimal Fastify request shape the auth helper needs. Full request type
 * lives in Fastify; we only read the three auth-sensitive fields here.
 */
export interface AuthRequestShape {
  user?: { id?: unknown; sub?: unknown } | Record<string, unknown>;
  scope?: { organizationId?: unknown } | Record<string, unknown>;
}

/**
 * The Fastify decorator `fastify.authenticate` is typed as a generic
 * preHandler, which doesn't match the `(request, reply)` positional shape
 * it actually uses under the hood. Narrow to the signature we invoke.
 */
type AuthenticateFn = (request: unknown, reply: unknown) => Promise<void>;

/**
 * Typed fake-reply shim — captures `reply.code(...)` calls to detect
 * rejection without actually writing an HTTP response (we're inside a WS
 * upgrade, so the `reply` object is never flushed to the wire).
 *
 * Exported for tests; hosts should not depend on this shape.
 */
export interface CaptureReply {
  code(statusCode: number): CaptureReply;
  send(): CaptureReply;
  readonly rejected: boolean;
  readonly statusCode: number | undefined;
  readonly sent: false;
}

export function createCaptureReply(): CaptureReply {
  let rejected = false;
  let capturedStatus: number | undefined;
  const reply: CaptureReply = {
    code(statusCode) {
      // Any .code() call from fastify.authenticate signals a rejection —
      // the auth plugin sets the status before calling .send(). Some
      // implementations use 401, some 403 — we treat both as "deny" and
      // let the caller decide the WS close code.
      rejected = true;
      capturedStatus = statusCode;
      return reply;
    },
    send() {
      return reply;
    },
    get rejected() {
      return rejected;
    },
    get statusCode() {
      return capturedStatus;
    },
    sent: false,
  };
  return reply;
}

/**
 * Run authentication against a request and return a uniform `AuthResult`
 * (or `null` if denied). Handles both modes:
 *
 *   - `customAuth` provided → call it directly; trust its return shape.
 *   - Otherwise → invoke `fastify.authenticate(request, captureReply)` to
 *     populate `request.user` / `request.scope`, then read IDs off those.
 *
 * This is the single source of truth for "did this request authenticate
 * successfully, and what identity did it establish". The handshake path
 * calls it once; the re-auth loop calls it on every interval.
 */
export async function authenticateWebSocket(
  fastify: FastifyInstance,
  request: unknown,
  customAuth: WebSocketPluginOptions["authenticate"],
): Promise<AuthResult | null> {
  if (customAuth) {
    try {
      return await customAuth(request);
    } catch {
      // Surface-level behaviour matches pre-split code: any throw → deny.
      // Tests that want to distinguish "threw" from "returned null"
      // should instrument customAuth directly.
      return null;
    }
  }

  const authenticate = (fastify as FastifyInstance & { authenticate?: AuthenticateFn })
    .authenticate;
  if (!authenticate) {
    // `auth: true` with neither customAuth nor fastify.authenticate is
    // rejected at plugin-register time. Reaching here would be a bug.
    return null;
  }

  const reply = createCaptureReply();
  try {
    await authenticate(request, reply);
  } catch {
    return null;
  }
  if (reply.rejected) {
    return null;
  }

  // fastify.authenticate populated request.user / request.scope.
  const shape = request as AuthRequestShape;
  const user = shape.user;
  const scope = shape.scope;
  if (!user) {
    return null;
  }

  const userId = readIdField(user, "id") ?? readIdField(user, "sub");
  const organizationId = scope ? readIdField(scope, "organizationId") : undefined;

  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(organizationId !== undefined ? { organizationId } : {}),
  };
}

function readIdField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}
