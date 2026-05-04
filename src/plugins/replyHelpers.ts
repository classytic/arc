/**
 * Reply helpers — `reply.sendList()` for list responses + `reply.stream()`
 * for binary downloads.
 *
 * Arc emits raw data on success (no envelope; HTTP status discriminates),
 * so single-doc handlers can just `return doc` or `reply.send(doc)` —
 * no helper needed. Errors throw `ArcError`; the global error handler
 * serializes to `ErrorContract`. The two helpers below cover the
 * remaining cases that DO need framework support:
 *
 *   - `sendList` normalizes any kit-shaped paginated/array result to
 *     the canonical wire envelope via repo-core's `toCanonicalList`.
 *   - `stream` sets the `Content-Type` / `Content-Disposition` headers
 *     for file downloads in one call.
 *
 * Opt in via `createApp({ replyHelpers: true })` or register directly.
 */

import type { PaginatedResult } from "@classytic/repo-core/pagination";
import { toCanonicalList } from "@classytic/repo-core/pagination";
import type { FastifyInstance, FastifyReply } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyReply {
    /**
     * Send a list response, normalised to the canonical wire shape.
     *
     * Accepts either a bare array (endpoints that don't paginate) or any
     * kit-shaped pagination result (`OffsetPaginationResult`,
     * `KeysetPaginationResult`, `AggregatePaginationResult`). Routes
     * through `toCanonicalList` from `@classytic/repo-core/pagination`
     * so server and typed-client (`@classytic/arc-next`) share one
     * declaration — the `method` discriminant cannot drift between them.
     */
    sendList<T>(input: T[] | readonly T[] | PaginatedResult<T>): FastifyReply;

    /**
     * Stream a readable source as a file download or raw stream.
     *
     * @example
     * return reply.stream(csvReadable, { contentType: 'text/csv', filename: 'export.csv' });
     */
    stream(
      source: import("node:stream").Readable | Buffer | AsyncIterable<unknown>,
      options: { contentType: string; filename?: string; statusCode?: number },
    ): FastifyReply;
  }
}

async function replyHelpersPluginFn(fastify: FastifyInstance): Promise<void> {
  fastify.decorateReply("sendList", function <
    T,
  >(this: FastifyReply, input: T[] | readonly T[] | PaginatedResult<T>) {
    // toCanonicalList accepts `readonly T[] | AnyPaginationResult<T>`; the
    // `BareListResult` arm of `PaginatedResult` collapses to the array
    // overload. Cast through unknown so TS picks the correct overload at
    // the call site without re-narrowing the input shape.
    return this.code(200).send(toCanonicalList(input as unknown as readonly T[]));
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
