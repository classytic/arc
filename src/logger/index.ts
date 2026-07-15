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

/**
 * Minimal structural slice of a pino-style logger (`fastify.log`). Each
 * level accepts `(msg)` or `(mergeObject, msg)` — the pino calling
 * convention, which differs from console's variadic `(...args)`.
 */
export interface PinoLike {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Bridge an `ArcLogWriter` onto a pino-style logger (`fastify.log`).
 *
 * arcLog call sites use the console convention — positional args like
 * `log.warn("message", { userId })` — which pino would silently drop
 * (extra args are printf interpolation values there). The bridge folds
 * string args into the message, merges object args into the pino merge
 * object, and maps `Error` instances to `{ err }` so pino's error
 * serializer applies.
 *
 * `createApp` installs this automatically so arc-internal warnings flow
 * through the host's transports, level, and redaction config.
 */
export function createPinoWriter(logger: PinoLike): ArcLogWriter {
  const emit =
    (level: keyof PinoLike) =>
    (...args: unknown[]): void => {
      const parts: string[] = [];
      let merge: Record<string, unknown> | undefined;
      for (const arg of args) {
        if (typeof arg === "string") {
          parts.push(arg);
        } else if (arg instanceof Error) {
          merge = { ...(merge ?? {}), err: arg };
        } else if (arg !== null && typeof arg === "object") {
          merge = { ...(merge ?? {}), ...(arg as Record<string, unknown>) };
        } else {
          parts.push(String(arg));
        }
      }
      const msg = parts.join(" ");
      if (merge) logger[level](merge, msg);
      else logger[level](msg);
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
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
