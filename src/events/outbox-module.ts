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
import { requestContext } from "../context/requestContext.js";
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
import { emitObserved } from "./eventPlugin.js";
import {
  canReportHealth,
  DEFAULT_RELAY_LAG_UNHEALTHY_MS,
  type OutboxHealth,
  readOutboxHealth,
} from "./outbox/health.js";
import type { OutboxRelayErrorHandler, RelayResult } from "./outbox/relay.js";
import { EventOutbox } from "./outbox.js";

/** Default relay cadence. Frequent enough that a retry is not a user-visible delay. */
const DEFAULT_RELAY_EVERY_MS = 5_000;

/** How long the readiness check reuses a relay-health reading. See `health.probeCacheMs`. */
const DEFAULT_PROBE_CACHE_MS = 5_000;

/** How often an unhealthy outbox is logged. See `health.alertEveryMs`. */
const DEFAULT_HEALTH_ALERT_EVERY_MS = 5 * 60_000;

/** First pause after a pass that lost leases; doubles per consecutive losing pass. */
const LEASE_LOSS_BACKOFF_BASE_MS = 1_000;
const LEASE_LOSS_BACKOFF_MAX_MS = 30_000;

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
  /**
   * Upper bound on relay passes per scheduled tick and per {@link OutboxModuleExports.requestDrain}.
   * Default `1`: one `relayBatch()` per tick, as before this option existed.
   *
   * With a value above 1 the module keeps relaying in the same tick while the last pass claimed
   * rows (`attempted > 0`) and relayed something (`relayed > 0`). A pass that claimed or relayed
   * nothing ends the loop; a pass that claimed fewer than `batchSize` rows does not, so a store
   * whose claim is capped below `batchSize` still drains. A backlog of 250 rows with
   * `batchSize: 100` then clears in one tick instead of three intervals, at the price of one extra
   * empty claim after the backlog clears (4 passes). A pass where every publish failed stops the
   * loop, so a transport outage never spins. The whole loop is one tracked pass, so `drain()`
   * waits for it. Must be an integer >= 1.
   *
   * Keep `maxPassesPerTick × batchSize` relays inside the relay schedule's lock lease. A longer
   * tick is safe on a store with claim leases (`claimPending`), but on the single-worker
   * `getPending` fallback a second worker could start relaying the same rows.
   */
  maxPassesPerTick?: number;
  /**
   * Lease duration for a claimed batch, in ms (`EventOutbox` default 30 000). Must
   * exceed the slowest single publish + ack: the relay stops publishing a batch when
   * its lease budget runs out and sizes later claims to fit it.
   */
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
   * Omit to report through the Arc app's structured logger; there `ownership_mismatch` is
   * logged once per pass as a `marker: 'OUTBOX_LEASE_LOST'` warning with counts (per row at
   * debug), and the relay backs off. Override for metrics, tracing, or
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
  /**
   * The relay's readiness check (`/_health/ready`, name `<name>.relay`). NON-critical:
   * a stalled relay is a cluster problem, and pulling this instance from rotation would
   * not drain it. Unhealthy when anything is dead-lettered or the oldest pending event
   * is older than `relayLagUnhealthyMs` (default 5 min), and when the store cannot
   * report either. `false` omits the check.
   *
   * `probeCacheMs` (default 5000) is how long the check reuses its last reading.
   * The reading costs two status counts and an oldest-pending lookup, and a
   * readiness probe runs on EVERY replica every few seconds — uncached, 50 pods
   * probed every 5 s is ~30 outbox queries a second, and a status count is at
   * its most expensive during a backlog, the moment the database has least to
   * spare. Concurrent probes also share one in-flight reading. Keep it at or
   * below the probe interval; `0` reads on every probe. The `health()` export is
   * never cached — an operator asking wants the current answer.
   *
   * `alertEveryMs` (default 5 min, `0` disables) schedules `<name>.health`, which logs
   * while unhealthy: `marker: 'OUTBOX_RELAY_LAG'` at error, `marker: 'OUTBOX_DEAD_LETTER'`
   * at warn. A readiness check is PULLED — nobody is paged by a degraded row in a probe
   * body, so the stall is also pushed into the log where alerting reads it. It is a
   * `kind: 'relay'` arm, so it runs wherever the relay runs (including a `role: 'relay'`
   * process). A store that cannot report counts is warned about once, not every tick.
   */
  health?: { relayLagUnhealthyMs?: number; probeCacheMs?: number; alertEveryMs?: number } | false;
}

/** Totals across the passes of one {@link OutboxModuleExports.drain}. */
export interface OutboxDrainResult {
  passes: number;
  relayed: number;
  publishFailed: number;
  deadLettered: number;
  /**
   * `true` once a pass found nothing VISIBLE to claim and no claimed row was left
   * unpublished for lack of lease budget (`RelayResult.leaseDeferred`; those stay
   * leased until expiry). Rows backing off after a failed publish are invisible until
   * their retry time, so read `publishFailed` too.
   */
  drained: boolean;
}

/** What the module exports at `fastify.arc.modules.<name>`. */
/** Options for {@link OutboxModuleExports.requestDrain}. */
export interface OutboxDrainRequest {
  /**
   * Relay only events of these types (exact names), oldest first, ahead of the rest of
   * the backlog: a priority nudge for rows that must not wait behind thousands of others
   * (an alarm committed while a bulk import drains). Coalesced with other typed requests
   * into one pass, in its own single-flight lane, so it never waits behind a running
   * untyped pass. Uses the
   * store's `claimPending({ types })`; on a store with only `getPending` the filter is
   * ignored. Empty or absent = an ordinary untyped nudge.
   */
  types?: readonly string[];
}

export interface OutboxModuleExports {
  /** The store, for consumers that write events transactionally. */
  store: OutboxStore;
  /** The relay, for a host that wants to drain on demand (tests, admin actions). */
  relay: EventOutbox;
  /**
   * Ask for a relay pass SOON, without waiting for the interval. Coalesced:
   * any number of calls before the pass runs produce ONE pass. Never throws
   * and returns nothing — a unit of work calls this after commit so a row it
   * just wrote is delivered in milliseconds rather than up to `relayEveryMs`
   * later. Single-flight: a call while a pass runs queues exactly ONE
   * follow-up that starts when it ends, never a concurrent pass. During a
   * lease-loss back-off the pass runs when the back-off ends.
   *
   * Calling from inside a request does NOT put the pass in that request's
   * scope: a pass drains whatever is pending, which is other requests' rows.
   * The pass runs scope-free, so each event opens its own (see `runWorkScope`).
   */
  requestDrain: (options?: OutboxDrainRequest) => void;
  /**
   * Relay passes until nothing visible is pending, and resolve with the totals —
   * including events published BY the handlers it ran. For tests that assert what
   * an event eventually did, and for a shutdown that should empty the queue.
   * Bounded by `maxPasses` (default 100). Runs outside the caller's request scope,
   * like {@link requestDrain}. Waits for this module's own in-flight passes (a nudge,
   * a scheduled tick), whose leased rows no other pass can see; rows leased by
   * ANOTHER process are not awaited.
   */
  drain: (options?: { maxPasses?: number }) => Promise<OutboxDrainResult>;
  /** The same reading as the readiness check. Throws when the store cannot report. */
  health: () => Promise<OutboxHealth>;
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
  const maxPassesPerTick = options.maxPassesPerTick ?? 1;
  if (!Number.isInteger(maxPassesPerTick) || maxPassesPerTick < 1) {
    throw new Error(
      `Outbox module "${name}": maxPassesPerTick must be an integer >= 1, got ${String(options.maxPassesPerTick)}.`,
    );
  }
  const lagUnhealthyMs =
    (options.health === false ? undefined : options.health?.relayLagUnhealthyMs) ??
    DEFAULT_RELAY_LAG_UNHEALTHY_MS;
  const probeCacheMs =
    (options.health === false ? undefined : options.health?.probeCacheMs) ?? DEFAULT_PROBE_CACHE_MS;
  // Refuse at construction, not at the first probe: a negative or non-finite
  // window would either never reuse a reading or never refresh one.
  if (!Number.isFinite(probeCacheMs) || probeCacheMs < 0) {
    throw new Error(
      `Outbox module "${name}": health.probeCacheMs must be a non-negative number, got ${String(probeCacheMs)}.`,
    );
  }
  const alertEveryMs =
    options.health === false ? 0 : (options.health?.alertEveryMs ?? DEFAULT_HEALTH_ALERT_EVERY_MS);
  if (!Number.isFinite(alertEveryMs) || alertEveryMs < 0) {
    throw new Error(
      `Outbox module "${name}": health.alertEveryMs must be a non-negative number, got ${String(alertEveryMs)}.`,
    );
  }
  let log: FastifyInstance["log"] | undefined;
  /** The unmeasurable-store warning is said once, not every alert tick. */
  let warnedUnmeasurable = false;

  /**
   * The readiness probe's reading, reused for `probeCacheMs` and shared by
   * concurrent probes (single-flight). A failed or unmeasurable reading is
   * cached as unhealthy for the same window — retrying a failing store on
   * every probe is load on the thing that is already failing.
   */
  let probeReading: { at: number; healthy: boolean } | undefined;
  let probeInFlight: Promise<boolean> | undefined;
  const probeHealthy = (read: () => Promise<OutboxHealth>): Promise<boolean> => {
    if (probeReading && Date.now() - probeReading.at < probeCacheMs) {
      return Promise.resolve(probeReading.healthy);
    }
    probeInFlight ??= read()
      .then(
        (h) => h.healthy,
        () => false,
      )
      .then((healthy) => {
        probeReading = { at: Date.now(), healthy };
        return healthy;
      })
      .finally(() => {
        probeInFlight = undefined;
      });
    return probeInFlight;
  };

  /**
   * Built at bootstrap and reused by the schedule.
   *
   * Not rebuilt per tick: `EventOutbox` carries the consumer id the lease is keyed on, and a fresh
   * instance per tick would be a fresh claimant every few seconds — which defeats the lease it
   * depends on for exactly-once publishing.
   */
  let exports: OutboxModuleExports | undefined;
  /** The untyped single-flight lane, built at bootstrap; the schedule runs in it too. */
  let backlogLane: PassLane | undefined;

  /** Passes THIS module started (nudge, schedule) that have not settled — `drain()` waits on them. */
  const inFlightPasses = new Set<Promise<unknown>>();
  const trackPass = <T>(pass: Promise<T>): Promise<T> => {
    inFlightPasses.add(pass);
    const untrack = (): void => {
      inFlightPasses.delete(pass);
    };
    pass.then(untrack, untrack);
    return pass;
  };

  /**
   * Up to `maxPassesPerTick` `relayBatch()` calls, continuing while the previous pass
   * claimed rows AND relayed something. A pass of only failures stops the loop: those rows
   * are backing off, and another pass would only re-claim the next batch into the same
   * outage. A pass that claimed nothing ends it.
   *
   * "Fewer than `batchSize`" does NOT end it: a store may cap one claim below
   * `batchSize` (a repository's page `maxLimit`, 100 by default in mongokit), and a
   * clamped page would read as "backlog empty" and strand the rest until the next tick.
   * The price is one empty claim after the backlog clears.
   */
  const relayPasses = async (relay: EventOutbox, types?: readonly string[]): Promise<boolean> => {
    if (backingOff()) return false;
    let passes = 0;
    for (;;) {
      const r = await relay.relayBatch(types ? { types } : undefined);
      passes++;
      if (observeLeaseLoss(r)) return true;
      if (passes >= maxPassesPerTick || !(r.attempted > 0) || r.relayed === 0) return true;
    }
  };

  /**
   * Lease-loss back-off. A pass whose ack or fail met an ownership mismatch lost
   * rows to another claimant: relaying again at once only re-claims into the same
   * contention. Passes pause for 1 s, doubling per consecutive losing pass up to
   * 30 s, and the loss is logged ONCE per pass with counts — the default `onError`
   * no longer logs it per row.
   */
  let leaseLossStreak = 0;
  let backoffUntil = 0;
  const backingOff = (): boolean => Date.now() < backoffUntil;
  const observeLeaseLoss = (r: RelayResult): boolean => {
    const lost = r.ownershipMismatches ?? 0;
    if (lost > 0) {
      leaseLossStreak++;
      const backoffMs = Math.min(
        LEASE_LOSS_BACKOFF_BASE_MS * 2 ** (leaseLossStreak - 1),
        LEASE_LOSS_BACKOFF_MAX_MS,
      );
      backoffUntil = Date.now() + backoffMs;
      log?.warn(
        {
          marker: "OUTBOX_LEASE_LOST",
          outbox: name,
          ownershipMismatches: lost,
          attempted: r.attempted,
          relayed: r.relayed,
          leaseDeferred: r.leaseDeferred ?? 0,
          consecutivePasses: leaseLossStreak,
          backoffMs,
        },
        `outbox relay "${name}" lost ${lost} lease(s) to another claimant; backing off ${backoffMs} ms`,
      );
      return true;
    }
    if (r.attempted > 0) leaseLossStreak = 0;
    return false;
  };
  /** A requested pass that met the back-off reruns when it ends (one timer per lane). */
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  const retryAfterBackoff = (lane: PassLane, armed: { timer: boolean }): void => {
    if (closed || armed.timer) return;
    armed.timer = true;
    const timer = setTimeout(
      () => {
        retryTimers.delete(timer);
        armed.timer = false;
        lane.request();
      },
      Math.max(0, backoffUntil - Date.now()),
    );
    timer.unref?.();
    retryTimers.add(timer);
  };

  return {
    name,

    bootstrap: (fastify: FastifyInstance): OutboxModuleExports => {
      log = fastify.log;
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
        onPublished: (event) => emitObserved(fastify.events, event),
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        consumerId: options.consumerId ?? mintConsumerId(name),
        onError:
          options.onError ??
          ((info) => {
            // Counted per pass and warned ONCE by `observeLeaseLoss`; an error
            // per row turned one slow batch into thousands of log lines.
            if (info.kind === "ownership_mismatch") {
              fastify.log.debug(
                { kind: info.kind, eventId: info.event?.meta.id },
                `outbox relay "${name}" lost a lease`,
              );
              return;
            }
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

      /**
       * Two single-flight lanes: `backlog` (untyped nudges, the scheduled tick,
       * `drain()`) and `priority` (typed nudges, so an alarm never waits behind
       * a slow backlog pass). Each runs at most ONE pass at a time; a request
       * during a pass queues exactly one follow-up that starts after it ends.
       * Overlapping passes were the livelock: the newer one re-claimed the older
       * one's expired rows, both ran the handlers, and the older ack failed.
       *
       * `exit` — NOT merely cosmetic. The lane's `setImmediate` preserves the
       * caller's AsyncLocalStorage store, and the caller is a REQUEST (that is the
       * documented use: drain the row I just committed). A pass drains whatever is
       * pending, so without this every event in the batch — including rows written
       * by other requests, for other tenants — dispatches inside the triggering
       * request's scope: `runWorkScope` inherits it rather than opening the
       * event's own, handlers read that request's `user`/`organizationId`/
       * `requestScopedCache`, and a child event published from one is stamped
       * with its `requestId` as `correlationId`. A relay pass belongs to no
       * request; say so.
       */
      const scopeFree = (fn: () => Promise<void>): Promise<void> =>
        requestContext.storage.exit(fn).catch((err: unknown) => {
          fastify.log.error({ err }, `outbox relay "${name}" requested drain failed`);
        });
      const backlogArmed = { timer: false };
      const backlog: PassLane = createPassLane(
        () =>
          scopeFree(async () => {
            if (!(await relayPasses(relay))) retryAfterBackoff(backlog, backlogArmed);
          }),
        trackPass,
      );
      /** Types asked for by typed requests not yet taken by a priority pass. */
      let typesQueued: Set<string> | null = null;
      const priorityArmed = { timer: false };
      const priority: PassLane = createPassLane(
        () =>
          scopeFree(async () => {
            const typed = typesQueued ? [...typesQueued] : undefined;
            typesQueued = null;
            if (!typed) return;
            if (!(await relayPasses(relay, typed))) {
              typesQueued ??= new Set();
              for (const t of typed) typesQueued.add(t);
              retryAfterBackoff(priority, priorityArmed);
            }
          }),
        trackPass,
      );
      backlogLane = backlog;

      const requestDrain = (options?: OutboxDrainRequest): void => {
        const types = Array.isArray(options?.types)
          ? options.types.filter((t): t is string => typeof t === "string" && t.length > 0)
          : [];
        if (types.length > 0) {
          typesQueued ??= new Set();
          for (const t of types) typesQueued.add(t);
          priority.request();
        } else {
          backlog.request();
        }
      };

      const drain = ({
        maxPasses = 100,
      }: {
        maxPasses?: number;
      } = {}): Promise<OutboxDrainResult> =>
        requestContext.storage.exit(async () => {
          const total: OutboxDrainResult = {
            passes: 0,
            relayed: 0,
            publishFailed: 0,
            deadLettered: 0,
            drained: false,
          };
          let deferred = false;
          while (total.passes < maxPasses) {
            // A nudged or scheduled pass may hold rows under lease — invisible to
            // this pass. Wait for it, or "nothing visible" is not "nothing pending".
            if (inFlightPasses.size > 0) await Promise.allSettled([...inFlightPasses]);
            // Through the backlog lane, so a nudge or tick never overlaps it.
            const r = await backlog.exclusive(() => relay.relayBatch());
            observeLeaseLoss(r);
            total.passes++;
            total.relayed += r.relayed;
            total.publishFailed += r.publishFailed;
            total.deadLettered += r.deadLettered;
            // Rows deferred past their lease budget stay leased, so invisible.
            if ((r.leaseDeferred ?? 0) > 0) deferred = true;
            if (r.attempted === 0 && inFlightPasses.size === 0) {
              total.drained = !deferred;
              break;
            }
          }
          return total;
        });

      const health = async (): Promise<OutboxHealth> => {
        if (!canReportHealth(store)) {
          throw new Error(
            `Outbox module "${name}": relay health needs BOTH countByStatus and ` +
              "oldestPendingAgeMs on the store, and it is missing at least one.",
          );
        }
        return readOutboxHealth(store, lagUnhealthyMs);
      };

      exports = { store, relay, requestDrain, drain, health };
      return exports;
    },

    /** Stop back-off retries; a timer firing after close would relay into a closed store. */
    onClose: (): void => {
      closed = true;
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    },

    ...(options.health === false
      ? {}
      : {
          healthChecks: [
            {
              name: `${name}.relay`,
              critical: false,
              // Unmeasurable is not healthy — `health()` throws, the probe reports
              // false. Read through `probeHealthy`: cached + single-flight.
              check: (): Promise<boolean> =>
                exports ? probeHealthy(exports.health) : Promise.resolve(false),
            },
          ],
        }),

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
          // `relayPasses` is ONE tracked pass however many batches it runs, so
          // `drain()` waits for the whole loop rather than racing its tail. It
          // runs in the backlog lane: a tick waits for a nudged pass, never
          // overlaps it, and is skipped during a lease-loss back-off.
          if (exports && backlogLane) {
            const relay = exports.relay;
            await trackPass<unknown>(backlogLane.exclusive(() => relayPasses(relay)));
          }
        },
      },
      ...(alertEveryMs > 0
        ? [
            {
              name: `${name}.health`,
              // `relay`, not the default `job`: the alarm must run wherever the
              // relay it watches runs. A `role: 'relay'` process mounts ONLY
              // relay-kind arms, so as a plain job this was skipped in exactly
              // the split topology `role` exists for — the relay ran, and its
              // stall alarm ran nowhere.
              kind: "relay" as const,
              every: alertEveryMs,
              handler: async (): Promise<void> => {
                if (!exports || !log) return;
                // A store without `countByStatus`/`oldestPendingAgeMs` cannot be
                // measured. The readiness check already reports that (red); here
                // it would throw every tick and log a schedule failure forever,
                // so say it ONCE and stop.
                if (!canReportHealth(exports.store)) {
                  if (!warnedUnmeasurable) {
                    warnedUnmeasurable = true;
                    log.warn(
                      { marker: "OUTBOX_HEALTH_UNMEASURABLE", outbox: name },
                      `outbox "${name}" store lacks countByStatus or oldestPendingAgeMs — relay stalls cannot be alerted on`,
                    );
                  }
                  return;
                }
                const h = await exports.health();
                if (h.deadLetter > 0) {
                  log.warn(
                    { marker: "OUTBOX_DEAD_LETTER", outbox: name, ...h },
                    `outbox "${name}" has dead-lettered events — inspect and replay them`,
                  );
                }
                if (h.relayLagMs !== null && h.relayLagMs >= lagUnhealthyMs) {
                  log.error(
                    { marker: "OUTBOX_RELAY_LAG", outbox: name, ...h },
                    `outbox "${name}" relay is behind — events are committed but not delivered`,
                  );
                }
              },
            },
          ]
        : []),
    ],
  };
}

/** A single-flight relay lane. See the lanes in `createOutboxModule`'s bootstrap. */
interface PassLane {
  /** Coalesced: queue one pass, after the in-flight one if any. Never throws. */
  request(): void;
  /** Run `fn` holding the lane, after any in-flight pass. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * `run` must not reject. A requested pass is tracked from the REQUEST, not from
 * its start, so `drain()` called right after a nudge waits for that pass.
 */
function createPassLane(
  run: () => Promise<void>,
  track: (pass: Promise<unknown>) => unknown,
): PassLane {
  let busy: Promise<unknown> | undefined;
  /** Resolves the tracked promise of the queued (not yet started) pass. */
  let queuedDone: (() => void) | undefined;
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(start);
  };
  const release = (): void => {
    busy = undefined;
    if (queuedDone) schedule();
  };
  function start(): void {
    scheduled = false;
    if (busy !== undefined || !queuedDone) return;
    const done = queuedDone;
    queuedDone = undefined;
    busy = run().finally(() => {
      done();
      release();
    });
  }
  return {
    request(): void {
      if (!queuedDone) {
        let resolve: () => void = () => {};
        track(new Promise<void>((r) => (resolve = r)));
        queuedDone = resolve;
      }
      if (busy === undefined) schedule();
    },
    async exclusive<T>(fn: () => Promise<T>): Promise<T> {
      while (busy !== undefined) await busy.catch(() => {});
      let done: () => void = () => {};
      busy = new Promise<void>((r) => (done = r));
      try {
        return await fn();
      } finally {
        done();
        release();
      }
    },
  };
}
