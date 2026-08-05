/**
 * A real `ModuleSetupContext` for tests that invoke a module's setup phases
 * DIRECTLY — `mod.bootstrap(app, ctx)`, `mod.plugins(app, ctx)` — instead of
 * booting a whole app through `createApp` / `bootModuleApp`.
 *
 * ## Why this is not `{ defer: () => {} }`
 *
 * That literal satisfies the type and throws away every disposer the module
 * registers. A test written against it passes whether the module releases what
 * it acquired or leaks it, so the one thing `defer` exists to make testable
 * becomes the one thing that cannot be tested. It also gives a false negative
 * in the other direction: a module that starts deferring later keeps its green
 * test, which is precisely the "compiles today, wrong tomorrow" shape the
 * disposer contract was introduced to remove.
 *
 * This collects them instead, and `dispose()` unwinds LIFO — the same order
 * arc's own teardown uses, so an ordering bug surfaces here rather than in
 * production shutdown.
 *
 * @example
 * ```ts
 * const setup = createTestModuleSetup();
 * const engine = await mod.bootstrap?.(app, setup.context);
 *
 * expect(setup.deferred).toHaveLength(1);   // it registered its teardown
 * await setup.dispose();                    // and it actually releases
 * expect(engine.closed).toBe(true);
 * ```
 */

import type { ModuleDisposer, ModuleSetupContext } from "../factory/module/disposers.js";

export interface TestModuleSetup {
  /** Pass this as the second argument to `bootstrap` / `plugins` / `afterResources`. */
  readonly context: ModuleSetupContext;
  /**
   * Disposers the module registered, in REGISTRATION order (`dispose()` runs
   * them backwards). Assert on `.length` to prove a phase registered teardown
   * at all — the check a no-op `defer` can never fail.
   */
  readonly deferred: readonly ModuleDisposer[];
  /**
   * Run every collected disposer LIFO, then clear them.
   *
   * Best-effort like arc's teardown: one throwing disposer never blocks the
   * ones behind it. Any errors are collected and thrown together at the end, so
   * a test still fails loudly instead of a rejection vanishing into a floating
   * promise.
   */
  dispose(): Promise<void>;
}

export function createTestModuleSetup(): TestModuleSetup {
  const deferred: ModuleDisposer[] = [];

  return {
    context: {
      defer(disposer) {
        if (typeof disposer !== "function") {
          throw new TypeError(
            `[arc/testing] defer() expected a function, received ${typeof disposer}.`,
          );
        }
        deferred.push(disposer);
      },
    },
    deferred,
    async dispose() {
      const errors: unknown[] = [];
      // LIFO, matching `DisposerRegistry.take`.
      for (let i = deferred.length - 1; i >= 0; i--) {
        const dispose = deferred[i];
        if (!dispose) continue;
        try {
          await dispose();
        } catch (err) {
          errors.push(err);
        }
      }
      deferred.length = 0;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `[arc/testing] ${errors.length} disposers threw`);
      }
    },
  };
}
