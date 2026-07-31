/**
 * Module lifecycle states — boot/teardown introspection over the composed
 * module graph.
 *
 * `hasModuleExports()` answers "did a bootstrap record a public export?", which
 * is deliberately NOT the same question as "is this module composed?" — a
 * resource-only module (no bootstrap, or a bootstrap returning `undefined`)
 * is composed yet never records an export. This file answers the composition
 * question: every resolved module gets an entry the moment the graph is
 * validated, and the entry tracks the module through its whole lifecycle.
 *
 * State machine (forward-only; every transition owned by registerResources /
 * the teardown controller):
 *
 *   resolved ──► bootstrapping ──► ready ──► closing ──► closed
 *                     │                                     │
 *                     └────────────► failed ◄───────────────┘
 *
 *   - resolved       graph validated (thunks imported, topologically ordered)
 *   - bootstrapping  the module's own `bootstrap()` is in flight
 *   - ready          init complete (modules without `bootstrap` jump here)
 *   - closing        its `onClose` is in flight (shutdown OR boot rollback)
 *   - closed         teardown complete — INCLUDING modules with no `onClose`
 *                    (the state tracks the APPLICATION lifecycle, not just
 *                    module-owned cleanup, so a resource-only module does not
 *                    sit at `ready` forever after `app.close()`)
 *   - failed         its `plugins()`/`bootstrap()` threw, or its `onClose` threw
 *
 * **`failed` is STICKY (terminal).** A module whose bootstrap threw is closed
 * by the boot rollback, and that cleanup succeeding must not rewrite the
 * record to `closed` — "initialization failed" is the fact an operator needs,
 * and a successful cleanup does not undo it. `setModuleState` therefore
 * refuses every transition out of `failed`.
 *
 * KNOWN LIMITATION: one flat union cannot express both dimensions — "failed to
 * init, cleaned up fine" and "inited fine, failed to clean up" both land on
 * `failed`. Distinguishing them needs a separate failure record
 * (`{ phase, error }`) rather than more union members; deliberately deferred
 * until the introspection surface (doctor/registry) has a concrete consumer.
 * Do NOT widen this union in the meantime.
 */

import type { FastifyInstance } from "fastify";

export type ModuleState = "resolved" | "bootstrapping" | "ready" | "closing" | "closed" | "failed";

/**
 * The honest read of the state map. `fastify.arc` is optional (see
 * fastify-augmentation.ts) and `moduleStates` is populated by
 * registerResources — both absent means "no module graph composed here"
 * (or a pre-2.31 embedding), so accessors degrade to undefined/false
 * rather than throwing.
 */
function readStates(fastify: FastifyInstance): Record<string, ModuleState> | undefined {
  return fastify.arc?.moduleStates;
}

/**
 * Record every composed module as `resolved`. Runs at the top of
 * registerResources, BEFORE any side-effecting phase — so from the first
 * lifecycle callback onward, `hasModule()` answers for the whole graph.
 * Null-proto map for the same reason as `arc.modules`: a module named
 * "__proto__" must be an own key, not a prototype write.
 */
export function initModuleStates(fastify: FastifyInstance, names: readonly string[]): void {
  const arc = fastify.arc;
  if (!arc) return; // direct registerResources embedding without arcCorePlugin
  const states = Object.create(null) as Record<string, ModuleState>;
  for (const name of names) states[name] = "resolved";
  arc.moduleStates = states;
}

/**
 * Internal transition writer — no-op when no state map exists (see above),
 * and no-op OUT of `failed`, which is terminal: rollback closes a module whose
 * bootstrap threw, and that cleanup succeeding must not erase the fact that
 * initialization failed (see the file header).
 */
export function setModuleState(fastify: FastifyInstance, name: string, state: ModuleState): void {
  const states = readStates(fastify);
  if (!states) return;
  if (states[name] === "failed") return;
  states[name] = state;
}

/**
 * Is `name` in the composed module graph? TRUE for resource-only modules and
 * modules that exported nothing — the question `hasModuleExports()` cannot
 * answer. FALSE before registerResources runs (no graph yet) and for
 * uncomposed names.
 */
export function hasModule(fastify: FastifyInstance, name: string): boolean {
  const states = readStates(fastify);
  return states !== undefined && Object.hasOwn(states, name);
}

/**
 * The module's current lifecycle state, or `undefined` when the module is not
 * composed (or no graph has been composed on this instance). See the state
 * machine in the file header.
 */
export function getModuleState(fastify: FastifyInstance, name: string): ModuleState | undefined {
  const states = readStates(fastify);
  return states !== undefined && Object.hasOwn(states, name) ? states[name] : undefined;
}
