import { AsyncLocalStorage } from "node:async_hooks";
import type { ArcLoggerOptions } from "./index.js";

/**
 * Internal — NOT a package entry. The per-app logger scope that
 * `@classytic/arc/logger` resolves against, plus the one hook-shaped entry
 * point `createApp` needs. Kept off the public barrel: hosts use
 * `runWithArcLogger` from `@classytic/arc/logger`.
 *
 * Per-app logger options, resolved from the async context.
 *
 * The process-global in `./index.ts` is a FALLBACK, not the source of truth. It
 * used to be both, and `configureArcLogger` overwrote it on every boot — so the
 * last-created app owned the writer for every app in the process. One app's
 * framework warnings then surfaced through another app's transports, level,
 * and redaction config. Fine for one-app-per-process; wrong for multi-app test
 * files and for serverless containers that reuse a warm process across apps.
 *
 * Follows the same shape as `requestContext`: the scope is entered once and
 * wraps everything downstream, so the `arcLog()` call sites keep their
 * zero-argument signature and resolve correctly without threading a logger.
 */
export const arcLoggerScope = new AsyncLocalStorage<ArcLoggerOptions>();

/**
 * Enter `options` for the remainder of the current async context.
 *
 * For Fastify's `onRequest` hook, where `run(store, done)` wraps the rest of
 * the request lifecycle. Outside a hook, use `runWithArcLogger`.
 */
export function enterArcLoggerScope(options: ArcLoggerOptions, done: () => void): void {
  arcLoggerScope.run(options, done);
}
