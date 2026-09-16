/**
 * Runtime capability registry — subsystems DECLARE what state they hold; one
 * boot audit enforces it against the selected `runtime` profile.
 *
 * The gap this closes: `validateDistributedRuntime` can only inspect what
 * `createApp` receives (`options.stores`, `arcPlugins`). Everything a host
 * wires inside `plugins()` / `bootstrap[]` — a webhook store, an audit store,
 * a realtime bus, a hand-rolled cache — was invisible to the guard and lived
 * on a wiki checklist instead. A checklist is not enforcement: the ERP host
 * that misses one line ships a replica-local store into a multi-replica
 * deployment and finds out from the data.
 *
 * So the checklist becomes declarations. A plugin holding process-local state
 * calls `declareRuntimeCapability` at registration; the audit runs at the END
 * of boot (after `plugins()` and modules, when every declarant has spoken)
 * and, under `runtime: 'distributed'`, fails on `durability: 'memory'`
 * declarations — unless the declarant marked itself `accepted` (state that is
 * per-process BY DESIGN, e.g. the response micro-cache, or a memory transport
 * under an explicit `singleProcess` declaration).
 *
 * The early guard keeps its job: fast-fail on constructor-visible stores
 * BEFORE any boot cost. This registry is the other half — same policy,
 * applied to what the guard cannot see. One policy, two collection points,
 * one enforcement.
 */

import type { FastifyInstance } from "fastify";

/** What a subsystem declares about the state it holds. */
export interface RuntimeCapabilityDeclaration {
  /** Dotted subsystem id, e.g. `'webhooks.subscriptions'`, `'events.transport'`. */
  subsystem: string;
  /** Where the state lives: `'memory'` = this process only; `'shared'` = external/durable. */
  durability: "memory" | "shared";
  /**
   * `'memory'` durability that is CORRECT by design (per-process micro-cache,
   * declared single-process topology). Audited as info, never an error —
   * acceptance must be stated by the declarant, not inferred by the audit.
   */
  accepted?: boolean;
  /** One line for the audit output: what breaks multi-replica, or why accepted. */
  detail?: string;
}

/**
 * `Symbol.for` so declarations from two arc copies in one dependency graph
 * land in ONE registry — same reasoning as `ARC_EVENT_TRANSPORT`. Not on the
 * public `fastify.arc` surface; the audit result is the product, not the list.
 */
const ARC_RUNTIME_CAPABILITIES = Symbol.for("arc.runtimeCapabilities");

/**
 * Seed the registry on the ROOT instance. `createApp` calls this the moment the
 * instance exists, before any registration — and that ordering is load-bearing,
 * not tidiness.
 *
 * A Fastify child (`register` with an un-`fp`-wrapped plugin) is
 * `Object.create(parent)`, so a symbol READ reaches the parent's array through
 * the prototype chain but a symbol WRITE always lands on the child. Created
 * lazily, the first declarant therefore decides where the registry lives: seeded
 * first, every child pushes into the root's one array; declared first from
 * inside an encapsulated child, that child gets an own array the root audit
 * never sees — a silent pass from the mechanism whose entire job is to refuse to
 * boot. Arc's own declarants are all `fp`-wrapped and both host `plugins()` and
 * module `plugins()` receive the root, so nothing internal hit this; a host
 * declaring from inside its own `fastify.register(async (child) => …)` would.
 *
 * Idempotent, and never clobbers an existing array — re-seeding an instance that
 * already collected declarations would discard them.
 */
export function initRuntimeCapabilityRegistry(fastify: FastifyInstance): void {
  const holder = fastify as unknown as Record<symbol, RuntimeCapabilityDeclaration[] | undefined>;
  if (!Object.hasOwn(holder, ARC_RUNTIME_CAPABILITIES)) {
    holder[ARC_RUNTIME_CAPABILITIES] = holder[ARC_RUNTIME_CAPABILITIES] ?? [];
  }
}

function registryOf(fastify: FastifyInstance): RuntimeCapabilityDeclaration[] {
  const holder = fastify as unknown as Record<symbol, RuntimeCapabilityDeclaration[] | undefined>;
  // Reads traverse the prototype chain, so a child finds the root's array once
  // `initRuntimeCapabilityRegistry` has seeded it. The fallback below only fires
  // for an instance arc did not build (a plugin registered on a bare Fastify),
  // where there is no audit to miss it.
  if (!holder[ARC_RUNTIME_CAPABILITIES]) holder[ARC_RUNTIME_CAPABILITIES] = [];
  return holder[ARC_RUNTIME_CAPABILITIES] as RuntimeCapabilityDeclaration[];
}

/**
 * Declare a runtime capability. Callable from ANY registration context —
 * arc's own plugins, host `plugins()` callbacks, module `plugins` phases,
 * and encapsulated children of any of them — which is the point: the audit
 * sees what the constructor-time guard cannot.
 */
export function declareRuntimeCapability(
  fastify: FastifyInstance,
  decl: RuntimeCapabilityDeclaration,
): void {
  registryOf(fastify).push(decl);
}

/**
 * The boot audit. Runs once at the end of `buildApp`, after every declarant —
 * on the SAME instance `initRuntimeCapabilityRegistry` seeded, which is what
 * makes declarations from encapsulated children visible here.
 *
 * - `runtime: 'distributed'` + `durability: 'memory'` + not `accepted` →
 *   collected and THROWN as one error naming every violator (fixing them one
 *   boot at a time is the checklist experience this replaces).
 * - accepted memory declarations → one info line, so the topology decision is
 *   visible in the boot log it was made for.
 * - non-distributed runtimes → nothing to enforce; declarations still logged
 *   at debug for `arc doctor`-style tooling.
 */
export function auditRuntimeCapabilities(
  fastify: FastifyInstance,
  runtime: "memory" | "distributed",
): void {
  const declarations = registryOf(fastify);
  if (declarations.length === 0) return;

  if (runtime !== "distributed") {
    fastify.log.debug(
      { capabilities: declarations },
      "[arc] runtime capabilities declared (no distributed profile — informational)",
    );
    return;
  }

  const violations = declarations.filter((d) => d.durability === "memory" && !d.accepted);
  const acceptedMemory = declarations.filter((d) => d.durability === "memory" && d.accepted);

  if (acceptedMemory.length > 0) {
    fastify.log.info(
      { accepted: acceptedMemory.map((d) => d.subsystem) },
      "[arc] per-process state accepted by design under runtime: 'distributed'",
    );
  }

  if (violations.length > 0) {
    const lines = violations
      .map((d) => `  - ${d.subsystem}${d.detail ? ` — ${d.detail}` : ""}`)
      .join("\n");
    throw new Error(
      `runtime: 'distributed' — ${violations.length} subsystem(s) hold PER-PROCESS state that ` +
        `multi-replica deployment breaks:\n${lines}\n` +
        "Wire a shared store for each, or — where per-process is genuinely intended — have the " +
        "declarant pass `accepted: true` with a reason.",
    );
  }
}
