/**
 * Graceful Shutdown Plugin
 *
 * Handles SIGTERM and SIGINT signals for clean shutdown:
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
 * // Production
 * await fastify.register(gracefulShutdownPlugin, {
 *   timeout: 30000, // 30 seconds max
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

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

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
   * Called when shutdown times out or encounters an error.
   * Defaults to `process.exit(1)` — appropriate for production but dangerous in:
   * - **Tests**: kills the test runner. Pass `() => {}` or `() => { throw … }`.
   * - **Shared runtimes** (e.g., serverless): may kill unrelated handlers.
   *
   * @param reason - `'timeout'` if shutdown exceeded `timeout` ms,
   *                 `'error'` if `onShutdown` or `fastify.close()` threw.
   */
  onForceExit?: (reason: 'timeout' | 'error') => void;
}

const gracefulShutdownPlugin: FastifyPluginAsync<GracefulShutdownOptions> = async (
  fastify: FastifyInstance,
  opts: GracefulShutdownOptions = {}
) => {
  const {
    timeout = 30000,
    onShutdown,
    signals = ['SIGTERM', 'SIGINT'],
    logEvents = true,
    onForceExit = () => process.exit(1),
  } = opts;

  let isShuttingDown = false;

  // Keep references to signal handlers so we can remove them on close
  const signalHandlers = new Map<string, () => void>();

  const shutdown = async (signal: string): Promise<void> => {
    // Prevent multiple shutdown attempts
    if (isShuttingDown) {
      if (logEvents) {
        fastify.log?.warn?.({ signal }, 'Shutdown already in progress, ignoring signal');
      }
      return;
    }
    isShuttingDown = true;

    if (logEvents) {
      fastify.log?.info?.({ signal, timeout }, 'Shutdown signal received, starting graceful shutdown');
    }

    // Set a hard timeout — force-exit only as last resort
    const forceExitTimer = setTimeout(() => {
      if (logEvents) {
        fastify.log?.error?.('Graceful shutdown timeout exceeded, forcing exit');
      }
      onForceExit('timeout');
    }, timeout);

    // Don't keep the process alive just for this timer
    forceExitTimer.unref();

    try {
      // 1. Stop accepting new connections and wait for in-flight requests
      if (logEvents) {
        fastify.log?.info?.('Closing server to new connections');
      }
      await fastify.close();

      // 2. Run custom cleanup (database connections, Redis, etc.)
      if (onShutdown) {
        if (logEvents) {
          fastify.log?.info?.('Running custom shutdown handler');
        }
        await onShutdown();
      }

      if (logEvents) {
        fastify.log?.info?.('Graceful shutdown complete');
      }

      clearTimeout(forceExitTimer);
      // Let Node.js exit naturally when the event loop drains
      // instead of calling process.exit(0) which skips cleanup
    } catch (err) {
      if (logEvents) {
        fastify.log?.error?.({ error: (err as Error).message }, 'Error during shutdown');
      }
      clearTimeout(forceExitTimer);
      onForceExit('error');
    }
  };

  // Register signal handlers (with references for cleanup)
  for (const signal of signals) {
    const handler = () => { void shutdown(signal); };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  // Cleanup signal handlers on close to prevent test pollution
  fastify.addHook('onClose', async () => {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.clear();
  });

  // Decorate fastify with manual shutdown trigger
  fastify.decorate('shutdown', async () => {
    await shutdown('MANUAL');
  });

  if (logEvents) {
    fastify.log?.debug?.({ signals }, 'Graceful shutdown plugin registered');
  }
};

// Extend Fastify types
declare module 'fastify' {
  interface FastifyInstance {
    /** Trigger graceful shutdown manually */
    shutdown: () => Promise<void>;
  }
}

export default fp(gracefulShutdownPlugin, {
  name: 'arc-graceful-shutdown',
  fastify: '5.x',
});

export { gracefulShutdownPlugin };
