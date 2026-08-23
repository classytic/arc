import { AsyncLocalStorage } from "node:async_hooks";

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
// Scoped + global state
// ============================================================================

/**
 * Per-app logger options, resolved from the async context.
 *
 * The process-global below is a FALLBACK, not the source of truth. It used to
 * be both, and `configureArcLogger` overwrote it on every boot — so the
 * last-created app owned the writer for every app in the process. One app's
 * framework warnings then surfaced through another app's transports, level,
 * and redaction config. Fine for one-app-per-process; wrong for multi-app test
 * files and for serverless containers that reuse a warm process across apps.
 *
 * Follows the same shape as `requestContext`: the scope is entered once and
 * wraps everything downstream, so the 23 `arcLog()` call sites keep their
 * zero-argument signature and resolve correctly without threading a logger.
 */
const scope = new AsyncLocalStorage<ArcLoggerOptions>();

let globalOptions: ArcLoggerOptions = {};

/** Active options: the app's if we're inside one, else the process fallback. */
function resolveOptions(): ArcLoggerOptions {
  return scope.getStore() ?? globalOptions;
}

/**
 * Run `fn` with `options` as the active logger config.
 *
 * `options` is held BY REFERENCE deliberately: `createApp` enters the scope
 * before Fastify exists, then fills in the pino writer once `fastify.log` is
 * constructed. Copying here would freeze the pre-Fastify view and send every
 * post-construction boot warning to the console instead of the app's logger.
 */
export function runWithArcLogger<T>(options: ArcLoggerOptions, fn: () => T): T {
  return scope.run(options, fn);
}

/**
 * Enter `options` for the remainder of the current async context.
 *
 * For Fastify's `onRequest` hook, where `run(store, done)` wraps the rest of
 * the request lifecycle. Outside a hook, prefer {@link runWithArcLogger}.
 */
export function enterArcLoggerScope(options: ArcLoggerOptions, done: () => void): void {
  scope.run(options, done);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Configure the PROCESS-GLOBAL Arc logger — the fallback used outside any app.
 *
 * `createApp` no longer routes its writer through here; each app carries its
 * own scoped options (see {@link runWithArcLogger}) so two apps in one process
 * cannot overwrite each other's. This remains the way to configure arcLog for
 * standalone use — `defineResource()` at module import, CLI commands, and any
 * code running before or outside a `createApp` boot.
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
  return resolveOptions().writer ?? console;
}

function isDebugEnabled(module: string): boolean {
  // Priority 1: Programmatic config — the app's if scoped, else the global.
  const configDebug = resolveOptions().debug;
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
