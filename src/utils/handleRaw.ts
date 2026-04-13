/**
 * handleRaw — Arc envelope wrapper for raw route handlers
 *
 * Wraps a raw Fastify handler so it returns Arc's standard response envelope
 * (`{ success: true, data }`) and maps errors to the standard error envelope
 * (`{ success: false, error, code }`). Eliminates the 3-line boilerplate
 * that every `raw: true` handler in downstream apps repeats.
 *
 * The handler function just returns data — `handleRaw` does the rest:
 * - Return value → `{ success: true, data }`
 * - `ArcError` subclass → `reply.code(err.statusCode).send(err.toJSON())`
 * - Error with `.statusCode` → uses that status code
 * - Generic Error → 500 with `{ success: false, error: message }`
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
 * Wrap a raw Fastify handler with Arc's response envelope and error handling.
 *
 * @param handler - Async function that receives `(request, reply)` and returns data.
 *   The return value is sent as `{ success: true, data }`. If it returns
 *   `undefined` or `null`, `{ success: true }` is sent (no `data` field).
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
        reply.code(statusCode).send({ success: true });
      } else {
        reply.code(statusCode).send({ success: true, data: result });
      }
    } catch (err) {
      // Don't double-send if reply was already sent before the throw
      if (reply.sent) return;

      if (err instanceof ArcError) {
        reply.code(err.statusCode).send(err.toJSON());
        return;
      }

      const error = err as Error & { statusCode?: number; status?: number; code?: string };
      const code = error.statusCode ?? error.status ?? 500;

      reply.code(code).send({
        success: false,
        error: error.message ?? "Internal server error",
        ...(error.code && { code: error.code }),
      });
    }
  };
}
