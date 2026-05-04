/**
 * handleRaw — Raw route helper that emits the data slot directly.
 *
 * Wraps a raw Fastify handler so it returns the canonical no-envelope
 * shape: success-path responses send `data` directly (HTTP status is the
 * wire discriminator), error-path responses funnel through the global
 * `ErrorContract` shape via `ArcError`.
 *
 * The handler function just returns data — `handleRaw` does the rest:
 * - Return value → sent raw (no envelope)
 * - `ArcError` subclass → `{ error, code, details? }` with `err.statusCode`
 * - Error with `.statusCode` → uses that status code
 * - Generic Error → 500 with `{ error }`
 * - Skips if `reply.sent` (streaming handlers, SSE)
 *
 * @example
 * ```typescript
 * import { handleRaw } from '@classytic/arc/utils';
 * import { ForbiddenError } from '@classytic/arc/utils';
 *
 * const getReport = handleRaw(async (req) => {
 *   if (!canAccess(req)) throw new ForbiddenError("Requires admin");
 *   return reportService.generate(buildContext(req));
 * });
 *
 * defineResource({
 *   routes: [{
 *     method: 'GET', path: '/report', raw: true,
 *     permissions: requireAuth(),
 *     handler: getReport,
 *   }],
 * });
 * ```
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { ArcError } from "./errors.js";

/**
 * Wrap a raw Fastify handler with Arc's response shape and error handling.
 *
 * @param handler - Async function that receives `(request, reply)` and returns data.
 *   The return value is sent raw (no envelope). If it returns `undefined`,
 *   the response body is empty (HTTP status only).
 * @param statusCode - HTTP status code for successful responses (default: 200)
 */
export function handleRaw<T>(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<T>,
  statusCode = 200,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const result = await handler(request, reply);

      // Handler may have already sent a response (streaming, SSE, redirect)
      if (reply.sent) return;

      if (result === undefined || result === null) {
        reply.code(statusCode).send();
      } else {
        reply.code(statusCode).send(result);
      }
    } catch (err) {
      // Don't double-send if reply was already sent before the throw
      if (reply.sent) return;

      if (err instanceof ArcError) {
        reply.code(err.statusCode).send({
          error: err.message,
          code: err.code,
          ...(err.details ? { details: err.details } : {}),
        });
        return;
      }

      const error = err as Error & { statusCode?: number; status?: number; code?: string };
      const code = error.statusCode ?? error.status ?? 500;

      reply.code(code).send({
        error: error.message ?? "Internal server error",
        ...(error.code && { code: error.code }),
      });
    }
  };
}
