/**
 * Per-module disposer stacks: a setup phase releases what it acquired, at the
 * point it acquired it. A disposer registered right after its resource exists
 * never exists if the line before it threw — partial-init teardown is exact.
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
 * ORDERING — disposers unwind LIFO. `onClose` runs FIRST: it destroys what
 * `bootstrap` RETURNED (the last thing produced), so an engine stops before a
 * connection deferred in `plugins` closes underneath it. `defer` everything and
 * omit `onClose` for one strict chain; either alone is complete.
 *
 * Rollback and shutdown each run them at most once in total —
 * {@link DisposerRegistry.take} drains the stack.
 */

import type { FastifyInstance } from "fastify";
import type { ArcPorts, ModulePorts, PortName } from "./types.js";

/** Teardown callback registered by a setup phase via `defer`. */
export type ModuleDisposer = () => void | Promise<void>;

/**
 * Second argument to a module's setup phases (`plugins`, `bootstrap`,
 * `afterResources`).
 */
export interface ModuleSetupContext<
  TPorts extends PortName = PortName,
  TOptionalPorts extends PortName = PortName,
> {
  /**
   * Register a teardown callback for the resource just acquired — call it
   * IMMEDIATELY after acquisition. Runs LIFO, after this module's `onClose`,
   * exactly once on rollback or shutdown. A throwing disposer is logged and
   * never blocks the rest.
   */
  defer(disposer: ModuleDisposer): void;
  /**
   * The ports THIS module declared in `requires`, frozen: each `ports` entry is present (boot
   * fails otherwise), each `optionalPorts` entry is the value or `undefined`. Nothing else.
   */
  readonly ports: ModulePorts<TPorts, TOptionalPorts>;
}

const NO_PORTS: ArcPorts = Object.freeze({});

/**
 * The one typing boundary for ports: `assertModuleRequirements` has already proven every
 * declared required port present, so the module's subset is read as its declared shape.
 */
export function asModulePorts(ports: ArcPorts): ModulePorts<PortName, PortName> {
  return ports as ModulePorts<PortName, PortName>;
}

export interface DisposerRegistry {
  /** The `{ defer }` context handed to `moduleName`'s setup phases. */
  contextFor(moduleName: string): ModuleSetupContext<PortName, PortName>;
  /**
   * Drain `moduleName`'s stack in LIFO order. Draining IS the once-guard:
   * a second call returns empty, so rollback and shutdown cannot double-run.
   */
  take(moduleName: string): ModuleDisposer[];
}

export function createDisposerRegistry(
  fastify: FastifyInstance,
  /** The ports handed to `moduleName`'s setup phases. Default: none. */
  portsOf: (moduleName: string) => ArcPorts = () => NO_PORTS,
): DisposerRegistry {
  const stacks = new Map<string, ModuleDisposer[]>();
  // A `defer` after its module was drained (an async tail still running when
  // boot failed) missed the sweep — it runs immediately instead of leaking.
  const drained = new Set<string>();
  const contexts = new Map<string, ModuleSetupContext<PortName, PortName>>();

  return {
    contextFor(moduleName) {
      const existing = contexts.get(moduleName);
      if (existing) return existing;
      const ctx: ModuleSetupContext<PortName, PortName> = {
        ports: asModulePorts(portsOf(moduleName)),
        defer(disposer) {
          if (typeof disposer !== "function") {
            throw new TypeError(
              `[arc] module "${moduleName}" called defer() with a ${typeof disposer} — expected a function.`,
            );
          }
          if (drained.has(moduleName)) {
            // Sweep is over, so it can't be awaited: failures are logged.
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
      return stack.reverse();
    },
  };
}
