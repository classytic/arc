/**
 * Transactional module teardown — the controller that guarantees a module's
 * `onClose` runs exactly once, whether boot succeeds (Fastify `onClose` hook)
 * or fails partway (immediate rollback).
 *
 * ── The bug this removes ────────────────────────────────────────────────────
 *
 * Before this controller, the combined module/app `onClose` hook was
 * registered at the very END of registerResources — deliberately, so it fires
 * before infra hooks under Fastify's LIFO close order. But that meant any
 * boot failure BETWEEN a module's bootstrap and that registration point
 * (a later module's bootstrap, app bootstrap, a resources factory,
 * afterResources) threw before the hook existed: module A's client/timer/
 * engine leaked with no teardown path at all. Event subscriptions had
 * explicit rollback; general bootstrap resources did not.
 *
 * The fix keeps the late hook registration (the LIFO ordering it buys is
 * load-bearing — see registerResources §7b) and adds an explicit rollback
 * path for the failure window:
 *
 *   - each module is marked eligible for teardown as soon as it ENTERS one of
 *     its own init phases (`plugins`, `bootstrap`) — those are the phases that
 *     open sockets, start timers, construct engines, and a callback that
 *     allocates and then throws must still be cleaned up;
 *   - on any later boot failure, `rollback()` closes eligible modules
 *     immediately, in REVERSE COMPOSITION order — read off the topologically
 *     sorted `modules` list, NOT the order marks arrived (see the note in
 *     `createModuleTeardown`) — best-effort (every closer is attempted;
 *     secondary failures are returned for logging, never thrown — the
 *     ORIGINAL boot error is what the caller rethrows);
 *   - a per-module once-guard makes the two paths safe to overlap: a closer
 *     consumed by rollback is skipped by the shutdown hook (and vice versa),
 *     so `fastify.close()` after a failed boot cannot double-close.
 *
 * Closer contract (documented on `ArcModule.onClose`): a closer may run after
 * a PARTIAL boot — e.g. the module's `plugins` opened a connection but its
 * `bootstrap` never ran. Closers must therefore tolerate half-initialized
 * state (guard `engine?.stop()`); a closer that throws is logged and counted
 * `failed`, and never blocks the remaining closers.
 */

import type { FastifyInstance } from "fastify";
import { setModuleState } from "./state.js";
import type { ArcModule } from "./types.js";

export interface ModuleTeardown {
  /**
   * Record that `module` is ENTERING an init phase and is now eligible for
   * teardown. Called immediately BEFORE `plugins()` and before `bootstrap()`
   * — not after — because a callback that allocates and then throws
   * (`client = await open(); await step2(); // throws`) is precisely the case
   * whose closer must run. Idempotent, and ELIGIBILITY only — close order
   * comes from the composed `modules` list, never from call order here.
   */
  markInitialized(module: ArcModule): void;
  /**
   * Close every initialized module in reverse composition order, best-effort.
   * Returns the secondary errors (for logging) — NEVER throws, so the caller
   * can rethrow the original boot error untouched.
   */
  rollback(): Promise<Error[]>;
  /** Same best-effort reverse-order sweep, for the shutdown (`onClose`) path. */
  closeAll(): Promise<Error[]>;
  /**
   * Whether any module was composed at all — the shutdown-hook gate. NOT
   * "declares an `onClose`": a closer-less module still needs the sweep to
   * advance its lifecycle state to `closed` (see `closeAll`).
   */
  hasComposedModules(): boolean;
}

export function createModuleTeardown(
  fastify: FastifyInstance,
  modules: readonly ArcModule[],
): ModuleTeardown {
  // ELIGIBILITY only — never ordering. `modules` (the `orderModules`
  // topological sort) is the sole ordering authority, because marking order is
  // NOT composition order: init runs as two global phases (every module's
  // `plugins`, then every module's `bootstrap`), so a dependant that has
  // `plugins` gets marked in phase 1 while a dependency that only has
  // `bootstrap` is marked in phase 2. Reversing mark order would then close the
  // dependency BEFORE its dependant — the exact inversion `dependsOn` exists to
  // prevent, and dangerous when a dependant's closer flushes through its
  // dependency's engine.
  const initializedNames = new Set<string>();
  // The once-guard: a name lands here the moment its closer is ATTEMPTED
  // (success or throw), so rollback + a later fastify.close() — or a re-fired
  // hook — can never run one closer twice.
  const consumed = new Set<string>();

  async function closeInitialized(): Promise<Error[]> {
    const errors: Error[] = [];
    // Reverse COMPOSITION order (dependants before dependencies).
    for (let index = modules.length - 1; index >= 0; index--) {
      const m = modules[index];
      if (!m || !initializedNames.has(m.name) || consumed.has(m.name)) continue;
      consumed.add(m.name);
      if (!m.onClose) {
        // No module-owned cleanup, but the module's lifecycle still ENDED
        // here — leaving it at `ready` after app.close() would contradict the
        // documented state machine. (`failed` is sticky, so a module that
        // failed to init is not laundered to `closed` by this.)
        setModuleState(fastify, m.name, "closed");
        continue;
      }
      setModuleState(fastify, m.name, "closing");
      try {
        await m.onClose(fastify);
        setModuleState(fastify, m.name, "closed");
      } catch (err) {
        setModuleState(fastify, m.name, "failed");
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
