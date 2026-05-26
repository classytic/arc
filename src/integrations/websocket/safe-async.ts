/**
 * Tiny logger-aware adapter for "fire-and-forget" async calls in
 * synchronous code paths (close handlers, send decorators, etc.).
 *
 * The 2.17.2 review surfaced that `void asyncCall()` patterns swallow
 * promise rejections — under load (Redis down, network blip), those
 * rejections become unhandled rejections that may crash the process
 * depending on `--unhandled-rejections` flag, and certainly never get
 * logged.
 *
 * `safeAsync(p, log, op, ctx)` catches the rejection, logs structured
 * metadata, and never throws back into the caller's synchronous frame.
 *
 * Critical-path callers should NOT use this — they should await and
 * decide whether to degrade or terminate. `safeAsync` is for paths
 * where the operation is genuinely "best effort" (persistence after
 * a successful socket write, release on close, stage-on-disconnect).
 */

import type { FastifyBaseLogger } from "fastify";

export type SafeAsyncLogger = Pick<FastifyBaseLogger, "warn">;

export function safeAsync(
  p: Promise<unknown>,
  logger: SafeAsyncLogger,
  op: string,
  ctx?: Record<string, unknown>,
): void {
  p.catch((err: unknown) => {
    logger.warn(
      {
        err,
        op,
        ...ctx,
      },
      `[arc-websocket] async op failed: ${op}`,
    );
  });
}
