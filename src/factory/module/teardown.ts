/**
 * Transactional module teardown: a module's `onClose` runs exactly once,
 * whether boot succeeds (Fastify `onClose` hook) or fails partway (rollback).
 *
 * The shutdown hook is registered LATE in registerResources (the LIFO ordering
 * that buys is load-bearing — see §7b there), so a boot failure before that
 * point has no hook. `rollback()` covers that window:
 *
 *   - a module becomes eligible the moment it ENTERS `plugins` or `bootstrap`
 *     — a callback that allocates and then throws must still be cleaned up;
 *   - closers run in REVERSE COMPOSITION order (the sorted `modules` list,
 *     never mark order), best-effort: secondary failures are returned for
 *     logging, never thrown, so the caller rethrows the ORIGINAL boot error;
 *   - a per-module once-guard lets rollback and shutdown overlap safely —
 *     `fastify.close()` after a failed boot cannot double-close.
 *
 * Closers may run after a PARTIAL boot, so they must tolerate half-initialized
 * state (`engine?.stop()`); a throwing closer marks the module `failed` and
 * never blocks the rest.
 */

import type { FastifyInstance } from "fastify";
import type { DisposerRegistry } from "./disposers.js";
import { setModuleState } from "./state.js";
import type { ArcModule } from "./types.js";

export interface ModuleTeardown {
  /**
   * Mark `module` eligible for teardown. Called BEFORE `plugins()` /
   * `bootstrap()`, not after — a callback that allocates then throws is exactly
   * the case whose closer must run. Idempotent; eligibility only, never order.
   */
  markInitialized(module: ArcModule): void;
  /**
   * Close every initialized module in reverse composition order, best-effort.
   * Returns secondary errors for logging — NEVER throws.
   */
  rollback(): Promise<Error[]>;
  /** Same sweep, for the shutdown (`onClose`) path. */
  closeAll(): Promise<Error[]>;
  /**
   * The shutdown-hook gate: any module composed, NOT "declares `onClose`" — a
   * closer-less module still needs the sweep to reach state `closed`.
   */
  hasComposedModules(): boolean;
}

export function createModuleTeardown(
  fastify: FastifyInstance,
  modules: readonly ArcModule[],
  disposers?: DisposerRegistry,
): ModuleTeardown {
  // ELIGIBILITY only — `modules` (topologically sorted) is the sole ordering
  // authority. Mark order is NOT composition order: init runs every module's
  // `plugins`, then every module's `bootstrap`, so a dependant with `plugins`
  // is marked before a bootstrap-only dependency. Reversing mark order would
  // close the dependency before its dependant.
  const initializedNames = new Set<string>();
  // Once-guard: added when a closer is ATTEMPTED (success or throw).
  const consumed = new Set<string>();

  async function closeInitialized(): Promise<Error[]> {
    const errors: Error[] = [];
    for (let index = modules.length - 1; index >= 0; index--) {
      const m = modules[index];
      if (!m || !initializedNames.has(m.name) || consumed.has(m.name)) continue;
      consumed.add(m.name);
      // `take` drains — also the disposer once-guard (see disposers.ts).
      const stack = disposers?.take(m.name) ?? [];
      if (!m.onClose && stack.length === 0) {
        // Lifecycle still ENDED; don't leave it at `ready`. `failed` is sticky,
        // so a module that failed init is not laundered to `closed`.
        setModuleState(fastify, m.name, "closed");
        continue;
      }
      setModuleState(fastify, m.name, "closing");
      let teardownFailed = false;
      // `onClose` FIRST, then disposers LIFO — see ordering note in disposers.ts.
      if (m.onClose) {
        try {
          await m.onClose(fastify);
        } catch (err) {
          teardownFailed = true;
          errors.push(
            new Error(
              `[arc] module "${m.name}" onClose() threw during teardown: ${
                err instanceof Error ? err.message : String(err)
              }`,
              { cause: err },
            ),
          );
        }
      }
      // Best-effort: neither a throwing disposer nor a failed `onClose` skips
      // the disposers behind it — they hold what still needs releasing.
      for (let d = 0; d < stack.length; d++) {
        const dispose = stack[d];
        if (!dispose) continue;
        try {
          await dispose();
        } catch (err) {
          teardownFailed = true;
          errors.push(
            new Error(
              `[arc] module "${m.name}" deferred disposer #${stack.length - d} threw during teardown: ${
                err instanceof Error ? err.message : String(err)
              }`,
              { cause: err },
            ),
          );
        }
      }
      setModuleState(fastify, m.name, teardownFailed ? "failed" : "closed");
    }
    return errors;
  }

  return {
    markInitialized(module) {
      initializedNames.add(module.name);
    },
    rollback: closeInitialized,
    closeAll: closeInitialized,
    hasComposedModules: () => modules.length > 0,
  };
}
