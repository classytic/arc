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
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { OutboxFailurePolicy, OutboxStore } from "@classytic/primitives/outbox";
import type { FastifyInstance } from "fastify";
import { transactionContext } from "../context/transactionContext.js";
/**
 * TYPE-only import of `ArcModule`, deliberately — `defineModule()` is pure identity
 * (inference only), and the declared return type below gives the same inference. Calling
 * it would make this a RUNTIME import of `factory` from `events`, which is an upward
 * layer edge (L2 → L5) and closes a `factory → events → factory` import cycle.
 * `scripts/check-boundaries.mjs` fails the build on both.
 */
import type { ArcModule } from "../factory/module/types.js";
import { type EventTransport, resolveEventTransport } from "./EventTransport.js";
import type { OutboxRelayErrorHandler } from "./outbox/relay.js";
import { EventOutbox } from "./outbox.js";

/** Default relay cadence. Frequent enough that a retry is not a user-visible delay. */
const DEFAULT_RELAY_EVERY_MS = 5_000;

/**
 * One relay identity per RELAY INSTANCE — `<name>:<hostname>:<pid>:<random>`.
 *
 * A lease identifies an independently executing CLAIMANT, not a crash domain.
 * Arc lets two outbox modules coexist (`name` is the `dependsOn` key), each
 * with its own schedule arm, and nothing stops two of them pointing at the
 * same store: they tick independently, so they are two claimants and must be
 * two identities. Scoping this per-process instead would have made the module
 * WEAKER than the primitive it wraps — `EventOutbox`'s own fallback is already
 * per-instance — and would leave the store unable to tell the two apart after
 * a lease expiry, which is exactly the stale-owner hole this replaced.
 *
 * Every component earns its place: `name` distinguishes co-resident modules,
 * `hostname:pid` makes a lease row legible in ops tooling, and the random
 * suffix breaks the tie a container restart creates — same hostname, often the
 * same pid, and the restarted process must not inherit a predecessor's
 * identity while that predecessor's lease is still live.
 *
 * Called once per `bootstrap()`, so the id is stable across every tick of the
 * relay it belongs to — which the lease depends on.
 */
function mintConsumerId(name: string): string {
  return `${name}:${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

export interface OutboxModuleOptions {
  /**
   * The durable store. Supply it directly, or as a factory when it needs the booted app
   * (a mongoose connection decorated by an earlier plugin, for instance).
   */
  store: OutboxStore | ((fastify: FastifyInstance) => OutboxStore);
  /**
   * Where relayed events are published. Omit to use the app's OWN transport — the ordinary case;
   * pass one only when the outbox must publish somewhere else.
   *
   * The default resolves the RAW `EventTransport` the events plugin registered, never the
   * `fastify.events` facade. The facade takes `(type, payload, meta?)` and swallows publish
   * errors under `failOpen` — both fatal here: the first makes every relayed event fail its
   * non-empty-string type guard, the second makes a failure read as success and acknowledges
   * the row. See `ARC_EVENT_TRANSPORT`.
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
   * Consumer id recorded on the lease. Default:
   * `<name>:<hostname>:<pid>:<random>` — UNIQUE PER RELAY INSTANCE.
   *
   * The lease is what stops two relays publishing the same event, and it can
   * only do that if they are distinguishable. The pre-2.34 default was the
   * shared literal `'arc-outbox-relay'`, which QUIETLY violated the rule the
   * doc stated: every process — and every co-resident module — was the same
   * logical owner, so a lease that expired and was re-claimed elsewhere looked
   * to the store's ownership check like the original owner never lost it. The
   * stale-owner protection was pinned open.
   *
   * Set this explicitly only to make lease ownership legible in ops tooling
   * (e.g. `billing-relay:pod-7`); whatever you set MUST stay distinct per
   * relay, not merely per deployment.
   */
  consumerId?: string;
  /**
   * Called for every non-fatal relay problem — publish failures, ownership mismatches,
   * acknowledge failures.
   *
   * Omit to report through the Arc app's structured logger. Override for metrics, tracing, or
   * external alerting. Silence here is the failure mode that matters: the relay keeps ticking,
   * rows keep failing, and the only symptom is revenue that never posted.
   *
   * **Fires per EVENT, not per batch.** With the defaults (`batchSize: 100`,
   * `relayEveryMs: 5000`) a transport outage emits up to 100 lines per tick —
   * ~1,200/minute — and that is UNBOUNDED without a {@link
   * OutboxModuleOptions.failurePolicy}: with no policy the row is failed with
   * neither `retryAt` nor `deadLetter`, so it stays pending and is retried on
   * every poll forever.
   *
   * Set a `failurePolicy` first — it bounds the retry loop and the logs
   * together. Reach for a custom `onError` when you want a different SHAPE
   * (aggregate per batch, sample, emit a metric); `() => {}` restores the
   * pre-2.34 silence, which is a choice worth making explicitly rather than
   * inheriting.
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
   * Unit-of-Work session provider. Defaults to `() => transactionContext.get()`.
   *
   * This is what makes the durable path the DEFAULT path rather than a
   * discipline. `EventOutbox.store()` already auto-injects a session from this
   * provider (explicit `options.session` still wins), and a `transactional:
   * true` write now publishes its session on `transactionContext` — so with
   * the default in place, `outbox.store(event)` inside a transactional write
   * commits the event row atomically with the domain write. No threading the
   * handle from the controller through every service layer to the call site.
   *
   * The default matters more than the capability: `auditPlugin` has defaulted
   * its `sessionProvider` the same way since it shipped, while this module
   * required every host to remember. A host that forgets does not get an
   * error — it gets an event row written outside the transaction, which
   * survives a rollback and reports something that never happened. That is
   * precisely the guarantee an outbox exists to provide.
   *
   * Pass `false` (or `() => undefined`) to opt out — for a store whose
   * writes must NOT join the caller's transaction (a separate connection,
   * an external queue).
   */
  sessionProvider?: (() => unknown) | false;
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
      /**
       * The RAW transport, never `fastify.events`.
       *
       * This read used to be `(fastify as { events?: EventTransport }).events` — a cast across
       * two INCOMPATIBLE shapes. The facade's `publish(type, payload, meta?)` took the relayed
       * `DomainEvent` as its `type` argument and failed the non-empty-string guard, so the
       * documented default path published NOTHING: subscribers saw nothing and every tick
       * reported `publishFailed: 1` until the row dead-lettered. The cast is what let two
       * mismatched signatures typecheck.
       */
      const transport =
        options.transport === undefined
          ? resolveEventTransport(fastify)
          : typeof options.transport === "function"
            ? options.transport(fastify)
            : options.transport;

      /**
       * No transport is BOOT-FATAL, because the alternative is invisible:
       * `EventOutbox.relayBatch()` returns an empty result when it has none, so the
       * module's schedule would tick forever, publish nothing, and let the store grow —
       * a durable backlog nobody is draining, reported as healthy. The failure this
       * module exists to prevent, arrived at from the other side.
       */
      if (transport === undefined) {
        throw new Error(
          `Outbox module "${name}" could not resolve an event transport, so its relay would ` +
            "tick forever without publishing while the store grows. Register arc's events " +
            "plugin (it is on by default — check `arcPlugins.events !== false`), or pass an " +
            "explicit `transport` to `createOutboxModule`. Note the outbox needs the RAW " +
            "EventTransport, not the `fastify.events` facade: the facade takes " +
            "`(type, payload, meta?)` and fails open, which would acknowledge rows whose " +
            "publish actually failed.",
        );
      }

      const relay = new EventOutbox({
        store,
        transport,
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        consumerId: options.consumerId ?? mintConsumerId(name),
        onError:
          options.onError ??
          ((info) => {
            fastify.log.error(
              {
                err: info.error,
                kind: info.kind,
                ...(info.event?.meta.id !== undefined ? { eventId: info.event.meta.id } : {}),
                ...(info.event?.type !== undefined ? { eventType: info.event.type } : {}),
              },
              `outbox relay "${name}" failed`,
            );
          }),
        ...(options.failurePolicy !== undefined ? { failurePolicy: options.failurePolicy } : {}),
        // `false` opts out; anything else defaults to the ambient session.
        ...(options.sessionProvider === false
          ? {}
          : { sessionProvider: options.sessionProvider ?? (() => transactionContext.get()) }),
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
        kind: "relay",
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
