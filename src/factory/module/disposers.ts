/**
 * Per-module disposer stacks — the generic teardown contract that lets a setup
 * phase release what it acquired, at the point it acquired it.
 *
 * `onClose` alone forced every resource into module scope behind a `?.`, because
 * rollback fires after a PARTIAL init and the slot cannot know how far
 * `bootstrap` got. `defer` makes that structural: a disposer registered the
 * moment its resource exists simply never exists if the line before it threw.
 *
 * ```ts
 * bootstrap: async (fastify, { defer }) => {
 *   const client = await openClient();
 *   defer(() => client.close());
 *   const sub = await client.subscribe();   // if this throws, only client closes
 *   defer(() => sub.close());
 * }
 * ```
 *
 * ORDERING — disposers unwind LIFO, so nothing is released while something
 * built on top of it is alive. `onClose` runs FIRST: it destroys what
 * `bootstrap` RETURNED (the engine), which is the last thing produced, so LIFO
 * puts it at the front — an engine must stop before the connection a `plugins`
 * phase deferred closes underneath it. For one strict chain with no special
 * case, `defer` everything and omit `onClose`; either alone is complete.
 *
 * Both teardown paths (mid-boot rollback, normal shutdown) run them exactly
 * once — {@link DisposerRegistry.take} drains the stack, so whichever arrives
 * first consumes it.
 */

import type { FastifyInstance } from "fastify";

/** Teardown callback registered by a setup phase via `defer`. */
export type ModuleDisposer = () => void | Promise<void>;

/**
 * Second argument to a module's setup phases (`plugins`, `bootstrap`,
 * `afterResources`).
 */
export interface ModuleSetupContext {
  /**
   * Register a teardown callback for the resource just acquired. Call it
   * IMMEDIATELY after acquisition — that is what makes partial-init teardown
   * exact rather than defensive.
   *
   * Disposers run LIFO, after this module's `onClose`, on both the rollback
   * and shutdown paths, and exactly once. A throwing disposer is logged and
   * never blocks the ones behind it.
   */
  defer(disposer: ModuleDisposer): void;
}

export interface DisposerRegistry {
  /** The `{ defer }` context handed to `moduleName`'s setup phases. */
  contextFor(moduleName: string): ModuleSetupContext;
  /**
   * Drain `moduleName`'s stack in LIFO order. Draining IS the once-guard:
   * a second call returns empty, so rollback and shutdown cannot double-run.
   */
  take(moduleName: string): ModuleDisposer[];
}

export function createDisposerRegistry(fastify: FastifyInstance): DisposerRegistry {
  const stacks = new Map<string, ModuleDisposer[]>();
  // Names whose stack has already been drained. A `defer` arriving after that
  // (an async tail still running when boot failed) has missed its sweep, so we
  // run it immediately rather than let the resource leak — see `contextFor`.
  const drained = new Set<string>();
  const contexts = new Map<string, ModuleSetupContext>();

  return {
    contextFor(moduleName) {
      const existing = contexts.get(moduleName);
      if (existing) return existing;
      const ctx: ModuleSetupContext = {
        defer(disposer) {
          if (typeof disposer !== "function") {
            throw new TypeError(
              `[arc] module "${moduleName}" called defer() with a ${typeof disposer} — expected a function.`,
            );
          }
          if (drained.has(moduleName)) {
            // Teardown already swept this module. Registering here would leak
            // silently, so release it now, best-effort. Cannot be awaited (the
            // sweep is over), so failures are logged, never thrown.
            void (async () => {
              try {
                await disposer();
              } catch (err) {
                fastify.log?.error(
                  { err, module: moduleName },
                  `[arc] module "${moduleName}" deferred a disposer after teardown had already run; it was invoked immediately and threw.`,
                );
              }
            })();
            return;
          }
          const stack = stacks.get(moduleName);
          if (stack) stack.push(disposer);
          else stacks.set(moduleName, [disposer]);
        },
      };
      contexts.set(moduleName, ctx);
      return ctx;
    },

    take(moduleName) {
      drained.add(moduleName);
      const stack = stacks.get(moduleName);
      if (!stack?.length) return [];
      stacks.delete(moduleName);
      // LIFO — reverse of registration.
      return stack.reverse();
    },
  };
}
