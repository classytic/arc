/**
 * Graceful Shutdown Plugin
 *
 * Handles SIGTERM and SIGINT signals for clean shutdown:
 * - Flips `fastify.shutdownState.draining` so `/ready` fails FIRST (lame duck)
 * - Keeps serving for `drainDelayMs` while the load balancer deregisters
 * - Stops accepting new connections
 * - Waits for in-flight requests to complete
 * - Closes database connections
 * - Exits cleanly
 *
 * Essential for Kubernetes deployments.
 *
 * @example
 * import { gracefulShutdownPlugin } from '@classytic/arc';
 *
 * // Production, behind a load balancer
 * await fastify.register(gracefulShutdownPlugin, {
 *   timeout: 30000, // 30 seconds max
 *   drainDelayMs: 10000, // > the LB's deregistration window
 *   onShutdown: async () => {
 *     await mongoose.disconnect();
 *     await redis.quit();
 *   },
 * });
 *
 * // Tests — prevent process.exit from killing the runner
 * await fastify.register(gracefulShutdownPlugin, {
 *   onForceExit: () => {},
 * });
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export interface GracefulShutdownOptions {
  /** Maximum time to wait for graceful shutdown in ms (default: 30000) */
  timeout?: number;
  /** Custom cleanup function called before exit */
  onShutdown?: () => Promise<void> | void;
  /** Signals to handle (default: ['SIGTERM', 'SIGINT']) */
  signals?: NodeJS.Signals[];
  /** Whether to log shutdown events (default: true) */
  logEvents?: boolean;
  /**
   * Lame-duck window in ms between flipping readiness and closing the
   * server (default: 0 — close immediately, the pre-2.41 behaviour).
   *
   * A load balancer keeps routing to an instance until its readiness
   * probe has failed for a few intervals; closing the moment SIGTERM
   * arrives is the classic rolling-deploy 502. Set this to exceed the LB's
   * deregistration window (typically 5000–15000) so `/ready` reports
   * `draining` while the instance still answers everything routed to it.
   * Counts against `timeout`.
   */
  drainDelayMs?: number;
  /**
   * Called when shutdown times out or encounters an error.
   * Defaults to `process.exit(1)` — appropriate for production but dangerous in:
   * - **Tests**: kills the test runner. Pass `() => {}` or `() => { throw … }`.
   * - **Shared runtimes** (e.g., serverless): may kill unrelated handlers.
   *
   * @param reason - `'timeout'` if shutdown exceeded `timeout` ms,
   *                 `'error'` if `onShutdown` or `fastify.close()` threw.
   */
  onForceExit?: (reason: "timeout" | "error") => void;
}

/**
 * Readable shutdown state — `fastify.shutdownState`. Set the moment a signal
 * (or `fastify.shutdown()`) arrives, BEFORE the server closes, so readiness
 * can start failing while the instance is still serving. `/live` ignores it:
 * a draining process is alive, that is the whole point of the window.
 */
export interface ShutdownState {
  /** True from the shutdown signal onward — never resets. */
  readonly draining: boolean;
  /** When draining began. */
  readonly since?: Date;
}

const gracefulShutdownPlugin: FastifyPluginAsync<GracefulShutdownOptions> = async (
  fastify: FastifyInstance,
  opts: GracefulShutdownOptions = {},
) => {
  const {
    timeout = 30000,
    onShutdown,
    signals = ["SIGTERM", "SIGINT"],
    logEvents = true,
    drainDelayMs = 0,
    onForceExit = () => process.exit(1),
  } = opts;

  // Mutable here, read-only through the decorator — the one source of truth
  // for "are we shutting down" (also the double-shutdown guard).
  const state: { draining: boolean; since?: Date } = { draining: false };

  // Keep references to signal handlers so we can remove them on close
  const signalHandlers = new Map<string, () => void>();

  const shutdown = async (signal: string): Promise<void> => {
    // Prevent multiple shutdown attempts
    if (state.draining) {
      if (logEvents) {
        fastify.log?.warn?.({ signal }, "Shutdown already in progress, ignoring signal");
      }
      return;
    }
    state.draining = true;
    state.since = new Date();

    if (logEvents) {
      fastify.log?.info?.(
        { signal, timeout, drainDelayMs },
        "Shutdown signal received, starting graceful shutdown",
      );
    }

    // Set a hard timeout — force-exit only as last resort
    const forceExitTimer = setTimeout(() => {
      if (logEvents) {
        fastify.log?.error?.("Graceful shutdown timeout exceeded, forcing exit");
      }
      onForceExit("timeout");
    }, timeout);

    // Don't keep the process alive just for this timer
    forceExitTimer.unref();

    try {
      // 0. Lame duck: readiness already reports `draining` (state above).
      // Keep serving until the load balancer has stopped sending traffic.
      if (drainDelayMs > 0) {
        if (logEvents) {
          fastify.log?.info?.({ drainDelayMs }, "Draining — readiness failing, still serving");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, drainDelayMs));
      }

      // 1. Stop accepting new connections and wait for in-flight requests
      if (logEvents) {
        fastify.log?.info?.("Closing server to new connections");
      }
      await fastify.close();

      // 2. Run custom cleanup (database connections, Redis, etc.)
      if (onShutdown) {
        if (logEvents) {
          fastify.log?.info?.("Running custom shutdown handler");
        }
        await onShutdown();
      }

      if (logEvents) {
        fastify.log?.info?.("Graceful shutdown complete");
      }

      clearTimeout(forceExitTimer);
      // Let Node.js exit naturally when the event loop drains
      // instead of calling process.exit(0) which skips cleanup
    } catch (err) {
      if (logEvents) {
        fastify.log?.error?.({ error: (err as Error).message }, "Error during shutdown");
      }
      clearTimeout(forceExitTimer);
      onForceExit("error");
    }
  };

  // Register signal handlers (with references for cleanup)
  for (const signal of signals) {
    const handler = () => {
      void shutdown(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  // Cleanup signal handlers on close to prevent test pollution
  fastify.addHook("onClose", async () => {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
  });

  // Decorate fastify with manual shutdown trigger
  fastify.decorate("shutdown", async () => {
    await shutdown("MANUAL");
  });
  // Same object the shutdown path mutates — readers see the flip immediately.
  fastify.decorate("shutdownState", state as ShutdownState);

  if (logEvents) {
    fastify.log?.debug?.({ signals, drainDelayMs }, "Graceful shutdown plugin registered");
  }
};

// Extend Fastify types
declare module "fastify" {
  interface FastifyInstance {
    /** Trigger graceful shutdown manually */
    shutdown: () => Promise<void>;
    /** Draining flag + start time; read by the health plugin's `/ready`. */
    shutdownState: ShutdownState;
  }
}

export default fp(gracefulShutdownPlugin, {
  name: "arc-graceful-shutdown",
  fastify: "5.x",
});

export { gracefulShutdownPlugin };
