/**
 * Arc Logger — Centralized debug & warning system
 *
 * Lightweight, zero-dependency logger for Arc framework internals.
 * Inspired by the `debug` npm package — disabled by default, opt-in via
 * environment variable or `createApp({ debug })` option.
 *
 * @example
 * ```typescript
 * // Enable via env var
 * ARC_DEBUG=1 node server.js        // all modules
 * ARC_DEBUG=scope,elevation node server.js // specific modules
 *
 * // Enable via createApp
 * const app = await createApp({ debug: true });
 * const app = await createApp({ debug: 'scope,elevation' });
 *
 * // Suppress warnings (not recommended)
 * ARC_SUPPRESS_WARNINGS=1 node server.js
 *
 * // Framework internals use:
 * import { arcLog } from '../logger/index.js';
 * const log = arcLog('elevation');
 * log.debug('Elevation applied', { userId });
 * log.warn('Something unexpected');
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export interface ArcLoggerOptions {
  /**
   * Enable debug output.
   * - `true` or `'*'` — all modules
   * - `string` — comma-separated module names (e.g., `'scope,elevation'`)
   * - `false` — disabled (default)
   */
  debug?: boolean | string;

  /**
   * Custom log writer. Defaults to `console`.
   * Useful for routing Arc logs into Fastify's pino logger or test fixtures.
   */
  writer?: ArcLogWriter;
}

export interface ArcLogWriter {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ArcLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ============================================================================
// Global State
// ============================================================================

let globalOptions: ArcLoggerOptions = {};

// ============================================================================
// Public API
// ============================================================================

/**
 * Configure the Arc logger globally.
 *
 * Called automatically by `createApp({ debug })`, but can also be
 * called manually for standalone usage outside of `createApp`.
 */
export function configureArcLogger(options: ArcLoggerOptions): void {
  globalOptions = { ...options };
}

/**
 * Create a module-scoped logger.
 *
 * Debug and info messages are gated by the `ARC_DEBUG` env var or
 * `createApp({ debug })` option. Warnings always show (unless
 * `ARC_SUPPRESS_WARNINGS=1`). Errors always show.
 *
 * @param module - Module name (e.g., 'scope', 'elevation', 'sse', 'preset')
 * @returns Logger instance for that module
 *
 * @example
 * ```typescript
 * const log = arcLog('elevation');
 * log.debug('Checking elevation header');
 * log.warn('No authenticate decorator found');
 * ```
 */
export function arcLog(module: string): ArcLogger {
  const prefix = `[arc:${module}]`;

  return {
    debug(...args: unknown[]) {
      if (isDebugEnabled(module)) {
        getWriter().debug(prefix, ...args);
      }
    },
    info(...args: unknown[]) {
      if (isDebugEnabled(module)) {
        getWriter().info(prefix, ...args);
      }
    },
    warn(...args: unknown[]) {
      if (isSuppressed()) return;
      getWriter().warn(prefix, ...args);
    },
    error(...args: unknown[]) {
      getWriter().error(prefix, ...args);
    },
  };
}

// ============================================================================
// Internals
// ============================================================================

function getWriter(): ArcLogWriter {
  return globalOptions.writer ?? console;
}

function isDebugEnabled(module: string): boolean {
  // Priority 1: Programmatic config
  const configDebug = globalOptions.debug;
  if (configDebug !== undefined && configDebug !== false) {
    return matchesModule(configDebug, module);
  }

  // Priority 2: Environment variable
  const envDebug = typeof process !== "undefined" ? process.env?.ARC_DEBUG : undefined;
  if (envDebug) {
    return matchesModule(envDebug, module);
  }

  return false;
}

function matchesModule(debug: boolean | string, module: string): boolean {
  if (debug === true) return true;
  if (typeof debug === "string") {
    const normalized = debug.trim();
    if (normalized === "1" || normalized === "true" || normalized === "*") return true;
    return normalized
      .split(",")
      .map((s) => s.trim())
      .includes(module);
  }
  return false;
}

function isSuppressed(): boolean {
  const env = typeof process !== "undefined" ? process.env?.ARC_SUPPRESS_WARNINGS : undefined;
  return env === "1" || env === "true";
}
