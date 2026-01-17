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
 * await fastify.register(gracefulShutdownPlugin, {
 *   timeout: 30000, // 30 seconds max
 *   onShutdown: async () => {
 *     await mongoose.disconnect();
 *     await redis.quit();
 *   },
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
  } = opts;

  let isShuttingDown = false;

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

    // Set a hard timeout
    const forceExitTimer = setTimeout(() => {
      if (logEvents) {
        fastify.log?.error?.('Graceful shutdown timeout exceeded, forcing exit');
      }
      process.exit(1);
    }, timeout);

    // Don't keep the process alive just for this timer
    forceExitTimer.unref();

    try {
      // 1. Stop accepting new connections
      if (logEvents) {
        fastify.log?.info?.('Closing server to new connections');
      }
      await fastify.close();

      // 2. Run custom cleanup
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
      process.exit(0);
    } catch (err) {
      if (logEvents) {
        fastify.log?.error?.({ error: (err as Error).message }, 'Error during shutdown');
      }
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  // Register signal handlers
  for (const signal of signals) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

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
