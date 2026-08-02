/**
 * The OUTBOX as a module — so the store is a SLOT other modules depend on, not a value the host
 * threads by hand.
 *
 * ## The failure this exists to make impossible
 *
 * A durable store passed as a constructor argument to N consumers will eventually miss one, and
 * the miss is silent. Observed in two independent ERP hosts on the same fleet:
 *
 *   - one passed an outbox to its revenue-attach seam and **not** to `createOrder`, so
 *     `order:created` published fire-and-forget — a failed publish discarded the revenue trigger
 *     entirely: no attach, no dead-letter, no log. Cash collected, nothing recorded.
 *   - the other had the identical gap, written independently.
 *
 * Six consumers had to be wired by hand in each host (order kernel, revenue kernel, access
 * kernel, revenue-attach durability, line-activation dead letters, promo-commit dead letters).
 * That is not a discipline problem; it is a design problem.
 *
 * As a module the store is registered ONCE and read from the registry. A consumer declares
 * `dependsOn: ['outbox']` and arc refuses to boot without it — the omission becomes a startup
 * failure instead of a quiet data-loss window.
 *
 * ## What this module does NOT do
 *
 * It does not build a store. Store construction is store-specific (a mongo model, a SQL table),
 * and arc is deliberately storage-agnostic — `repositoryAsOutboxStore` already adapts any
 * repository, and kits own their own schema (e.g. `@classytic/mongokit/outbox`). This module owns
 * the three things that are genuinely arc's: the module SLOT, the relay SCHEDULE, and shutdown.
 */

/**
 * The store contract is `@classytic/primitives/outbox`'s, not arc's — arc adapts to it rather
 * than owning it, which is why a kit (mongokit) can supply a store with no arc dependency.
 */
import type { OutboxFailurePolicy, OutboxStore } from "@classytic/primitives/outbox";
import type { FastifyInstance } from "fastify";
/**
 * TYPE-only import of `ArcModule`, deliberately — `defineModule()` is pure identity
 * (inference only), and the declared return type below gives the same inference. Calling
 * it would make this a RUNTIME import of `factory` from `events`, which is an upward
 * layer edge (L2 → L5) and closes a `factory → events → factory` import cycle.
 * `scripts/check-boundaries.mjs` fails the build on both.
 */
import type { ArcModule } from "../factory/module/types.js";
import type { EventTransport } from "./EventTransport.js";
import type { OutboxRelayErrorHandler } from "./outbox/relay.js";
import { EventOutbox } from "./outbox.js";

/** Default relay cadence. Frequent enough that a retry is not a user-visible delay. */
const DEFAULT_RELAY_EVERY_MS = 5_000;

export interface OutboxModuleOptions {
  /**
   * The durable store. Supply it directly, or as a factory when it needs the booted app
   * (a mongoose connection decorated by an earlier plugin, for instance).
   */
  store: OutboxStore | ((fastify: FastifyInstance) => OutboxStore);
  /**
   * Where relayed events are published. Omit to use `fastify.events` — the ordinary case; pass
   * one only when the outbox must publish somewhere other than the app's own transport.
   */
  transport?: EventTransport | ((fastify: FastifyInstance) => EventTransport);
  /** Module name, and therefore the `dependsOn` key. Default `'outbox'`. */
  name?: string;
  /** Relay interval in ms. Default 5000. */
  relayEveryMs?: number;
  /**
   * Rows per relay tick. Left to the store's own default when omitted — a batch size is a
   * throughput tuning decision, not something this module should invent.
   */
  batchSize?: number;
  /** Lease duration for a claimed batch, in ms. */
  leaseMs?: number;
  /**
   * Consumer id recorded on the lease. Default `'arc-outbox-relay'`.
   *
   * Give each relaying process a DISTINCT id when several run: the lease is what stops two
   * relays publishing the same event, and it can only do that if they are distinguishable.
   */
  consumerId?: string;
  /**
   * Called for every non-fatal relay problem — publish failures, ownership mismatches,
   * acknowledge failures.
   *
   * **Wire this.** Silence here is the failure mode that matters: the relay keeps ticking, rows
   * keep failing, and the only symptom is revenue that never posted.
   */
  onError?: OutboxRelayErrorHandler;
  /**
   * Retry / dead-letter policy for a failed publish — `({ attempts }) => { retryAt } |
   * { deadLetter: true }`.
   *
   * Omitting it takes `EventOutbox`'s default. Exposed because a real host had one and losing it
   * on adoption would be a silent downgrade: without a policy a permanently-failing row either
   * retries forever or dead-letters on the first blip, and both are wrong for money. A typical
   * shape is exponential backoff up to N attempts, then dead-letter.
   */
  failurePolicy?: OutboxFailurePolicy;
  /**
   * Run one relay pass at boot. Default `true` — a process that restarts with a backlog should
   * drain it immediately rather than waiting a full interval, because that backlog is precisely
   * the events the previous process failed to publish.
   */
  runOnStart?: boolean;
}

/** What the module exports at `fastify.arc.modules.<name>`. */
export interface OutboxModuleExports {
  /** The store, for consumers that write events transactionally. */
  store: OutboxStore;
  /** The relay, for a host that wants to drain on demand (tests, admin actions). */
  relay: EventOutbox;
}

/**
 * Compose the outbox as a module.
 *
 * ```ts
 * // host
 * const model = createOutboxModel(connection, { visibleAtField: 'nextVisibleAt' });
 * createApp({ modules: [
 *   createOutboxModule({
 *     store: repositoryAsOutboxStore(new Repository(model), { visibleAtField: 'nextVisibleAt' }),
 *     onError: (err, ctx) => app.log.error({ err, ...ctx }, 'outbox relay'),
 *   }),
 *   …
 * ]});
 *
 * // consumer module
 * defineModule({
 *   name: 'order',
 *   dependsOn: ['outbox'],
 *   bootstrap: (f) => createOrder({
 *     outbox: getModuleExports<OutboxModuleExports>(f, 'outbox').store,
 *   }),
 * });
 * ```
 *
 * `dependsOn` is doing real work there: it both orders the bootstraps and makes a missing outbox a
 * boot error naming the module that needed it.
 */
export function createOutboxModule(options: OutboxModuleOptions): ArcModule<OutboxModuleExports> {
  const name = options.name ?? "outbox";
  const relayEveryMs = options.relayEveryMs ?? DEFAULT_RELAY_EVERY_MS;

  /**
   * Built at bootstrap and reused by the schedule.
   *
   * Not rebuilt per tick: `EventOutbox` carries the consumer id the lease is keyed on, and a fresh
   * instance per tick would be a fresh claimant every few seconds — which defeats the lease it
   * depends on for exactly-once publishing.
   */
  let exports: OutboxModuleExports | undefined;

  return {
    name,

    bootstrap: (fastify: FastifyInstance): OutboxModuleExports => {
      const store = typeof options.store === "function" ? options.store(fastify) : options.store;
      const transport =
        options.transport === undefined
          ? (fastify as unknown as { events?: EventTransport }).events
          : typeof options.transport === "function"
            ? options.transport(fastify)
            : options.transport;

      const relay = new EventOutbox({
        store,
        ...(transport !== undefined ? { transport } : {}),
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        consumerId: options.consumerId ?? "arc-outbox-relay",
        ...(options.onError !== undefined ? { onError: options.onError } : {}),
        ...(options.failurePolicy !== undefined ? { failurePolicy: options.failurePolicy } : {}),
      });

      exports = { store, relay };
      return exports;
    },

    /**
     * The relay runs on the module's OWN schedule arm, so the host stops owning the tick — and
     * a host that forgets to start one cannot exist.
     */
    scheduledJobs: () => [
      {
        name: `${name}.relay`,
        every: relayEveryMs,
        runOnStart: options.runOnStart ?? true,
        handler: async (): Promise<void> => {
          // Undefined only if a schedule somehow fires before bootstrap; skipping is correct —
          // the next tick has the relay, and there is nothing to drain into yet.
          await exports?.relay.relay();
        },
      },
    ],
  };
}
