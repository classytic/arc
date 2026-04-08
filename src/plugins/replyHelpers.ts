/**
 * Reply Helpers Plugin — Consistent response envelope decorators.
 *
 * Decorates `reply` with `.ok()`, `.fail()`, and `.paginated()` methods
 * so handlers don't manually construct `{ success, data, error }` envelopes.
 *
 * Opt-in via `createApp({ replyHelpers: true })` or register directly.
 *
 * @example
 * ```typescript
 * // In handlers:
 * return reply.ok({ inserted: 3, skipped: 0 });
 * // → 200 { success: true, data: { inserted: 3, skipped: 0 } }
 *
 * return reply.ok(product, 201);
 * // → 201 { success: true, data: { ... } }
 *
 * return reply.fail('Missing field');
 * // → 400 { success: false, error: 'Missing field' }
 *
 * return reply.fail('Parse failed', 422);
 * // → 422 { success: false, error: 'Parse failed' }
 *
 * return reply.fail(['Name required', 'Price invalid'], 422);
 * // → 422 { success: false, errors: ['Name required', 'Price invalid'] }
 *
 * return reply.paginated({ docs, total, page, limit });
 * // → 200 { success: true, docs: [...], total, page, limit, ... }
 * ```
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import fp from "fastify-plugin";

// ============================================================================
// Type augmentation
// ============================================================================

declare module "fastify" {
  interface FastifyReply {
    /** Send a success response with data */
    ok<T>(data: T, statusCode?: number): FastifyReply;
    /** Send an error response */
    fail(error: string | string[], statusCode?: number): FastifyReply;
    /** Send a paginated list response */
    paginated<T>(result: {
      docs: T[];
      total: number;
      page: number;
      limit: number;
      [key: string]: unknown;
    }): FastifyReply;
    /**
     * Stream a readable source as a file download or raw stream.
     *
     * @example
     * ```typescript
     * // CSV export
     * return reply.stream(csvReadableStream, {
     *   contentType: 'text/csv',
     *   filename: 'export.csv',
     * });
     *
     * // PDF download
     * return reply.stream(pdfBuffer, {
     *   contentType: 'application/pdf',
     *   filename: 'report.pdf',
     * });
     *
     * // Raw stream (no Content-Disposition)
     * return reply.stream(dataStream, { contentType: 'application/octet-stream' });
     * ```
     */
    stream(
      source: import("node:stream").Readable | Buffer | AsyncIterable<unknown>,
      options: {
        contentType: string;
        filename?: string;
        statusCode?: number;
      },
    ): FastifyReply;
  }
}

// ============================================================================
// Plugin
// ============================================================================

async function replyHelpersPluginFn(fastify: FastifyInstance): Promise<void> {
  fastify.decorateReply("ok", function <T>(this: FastifyReply, data: T, statusCode = 200) {
    return this.code(statusCode).send({ success: true, data });
  });

  fastify.decorateReply(
    "fail",
    function (this: FastifyReply, error: string | string[], statusCode = 400) {
      if (Array.isArray(error)) {
        return this.code(statusCode).send({ success: false, errors: error });
      }
      return this.code(statusCode).send({ success: false, error });
    },
  );

  fastify.decorateReply("paginated", function <
    T,
  >(this: FastifyReply, result: { docs: T[]; total: number; page: number; limit: number; [key: string]: unknown }) {
    return this.code(200).send({ success: true, ...result });
  });

  fastify.decorateReply(
    "stream",
    function (
      this: FastifyReply,
      source: import("node:stream").Readable | Buffer | AsyncIterable<unknown>,
      options: { contentType: string; filename?: string; statusCode?: number },
    ) {
      this.code(options.statusCode ?? 200);
      this.header("content-type", options.contentType);
      if (options.filename) {
        this.header("content-disposition", `attachment; filename="${options.filename}"`);
      }
      return this.send(source);
    },
  );
}

export const replyHelpersPlugin = fp(replyHelpersPluginFn, {
  name: "arc-reply-helpers",
  fastify: "5.x",
});
