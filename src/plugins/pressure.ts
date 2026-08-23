/**
 * Admission control — ONE place that decides "are we saturated?".
 *
 * ## Why this is a module and not another flag
 *
 * Arc already sheds load, but only on event-loop lag, via `@fastify/under-
 * pressure`. Event-loop lag is a LATE signal: by the time the loop is behind,
 * the work causing it is already admitted and in flight. The costs that
 * actually saturate a backend — a drained connection pool, a queue nobody is
 * draining, an outbox falling behind — are invisible to it, and each one grew
 * its own knob in a different plugin.
 *
 * Rate limiting is a different axis and does not substitute: it bounds request
 * FREQUENCY. Admission control bounds concurrent EXPENSIVE WORK. Ten requests
 * per second is fine until each one holds a connection for four seconds.
 *
 * ## The interface is the policy, not the plumbing
 *
 * Signals are REGISTERED, not enumerated. That is deliberate, and it is what
 * keeps this honest: of the four signals the roadmap names — ELU, DB pool
 * saturation, queue depth, oldest-outbox age — only ELU has a source arc can
 * read today. No kit exposes pool statistics, no queue exposes depth, and no
 * outbox store reports its oldest pending row. Hard-coding four readers would
 * ship three seams with zero adapters behind them.
 *
 * So arc owns the DECISION (normalise, combine, threshold, act) and takes
 * signals from whoever can actually produce them. ELU ships built in because
 * arc can read it without help; the rest arrive as their sources appear,
 * without this module changing shape.
 *
 * ## What a signal must mean
 *
 * `read()` returns SATURATION in `[0, 1]`: 0 idle, 1 "cannot take more". Every
 * signal normalises itself because only the signal's author knows what full
 * means — 90% of a connection pool is nearly fatal, 90% ELU is busy but fine.
 * Returning a raw count here would push that judgement into this module, which
 * cannot make it.
 *
 * @example
 * ```typescript
 * await app.register(pressurePlugin, {
 *   signals: [{ name: 'db-pool', read: () => pool.borrowed / pool.size }],
 * });
 *
 * if (app.pressure.state() === 'saturated') reply.code(503).send();
 * ```
 */

import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { arcLog } from "../logger/index.js";
import type { HealthCheck } from "./health.js";

const log = arcLog("pressure");

// ── Contract ────────────────────────────────────────────────────────────

/**
 * One measurable source of load, normalised by whoever owns it.
 *
 * A throwing or hanging `read()` must never take the app down with it — the
 * reader is diagnostic, and a broken thermometer is not a fire. Failures are
 * logged once per signal and the signal reports 0 until it recovers.
 */
export interface PressureSignal {
  /** Stable identity — appears in snapshots and logs. */
  readonly name: string;
  /** Saturation in [0, 1]. Values outside the range are clamped. */
  read(): number | Promise<number>;
}

/** `ok` → serve · `degraded` → serve, shed what is optional · `saturated` → refuse. */
export type PressureState = "ok" | "degraded" | "saturated";

export interface PressureThresholds {
  /** Enter `degraded` at or above this. Default 0.8. */
  degraded?: number;
  /** Enter `saturated` at or above this. Default 0.95. */
  saturated?: number;
}

export interface PressureSnapshot {
  readonly state: PressureState;
  /** Highest signal — the one that decided the state. */
  readonly worst: { name: string; value: number } | undefined;
  readonly signals: Readonly<Record<string, number>>;
}

export interface PressureOptions {
  /** Extra signals beyond the built-in ELU reader. */
  signals?: PressureSignal[];
  thresholds?: PressureThresholds;
  /** Sampling cadence in ms. Default 1000. */
  intervalMs?: number;
  /** Include the built-in event-loop-utilisation signal. Default true. */
  eventLoopUtilization?: boolean;
  /** Fired when the state CHANGES — not on every sample. */
  onStateChange?: (next: PressureState, snapshot: PressureSnapshot) => void;
  /**
   * Refuse requests with 503 while `saturated`. Default OFF.
   *
   * Opt-in because arc cannot know which of a host's routes are sheddable. A
   * checkout POST and a dashboard chart both look like requests here, and
   * shedding the wrong one under load is worse than serving it slowly. Turn it
   * on once you know which paths to exclude.
   *
   * `exclude` is matched against `request.url` by prefix. Health and readiness
   * routes are ALWAYS exempt: shedding the probe that reports saturation
   * removes the orchestrator's only way to see it, and a 503 on
   * `/_health/ready` reads as "process dead" rather than "process full".
   */
  shed?: boolean | { statusCode?: number; retryAfterSeconds?: number; exclude?: string[] };
}

export interface PressureApi {
  state(): PressureState;
  snapshot(): PressureSnapshot;
  /** Register a signal after boot — for modules that resolve their source late. */
  register(signal: PressureSignal): void;
  /** True at `saturated`. The check a handler makes before admitting work. */
  shouldShed(): boolean;
  /**
   * A readiness check for `healthPlugin({ checks })`.
   *
   * NOT registered automatically: flipping readiness pulls the instance out of
   * its load balancer, which is the correct response to saturation in one
   * topology and a self-inflicted outage in another (a single instance would
   * remove the only server). The host composes it deliberately:
   *
   * ```ts
   * await app.register(healthPlugin, { checks: [app.pressure.readinessCheck()] });
   * ```
   *
   * Reports unhealthy only at `saturated` — `degraded` still serves, so it must
   * still read ready.
   */
  readinessCheck(options?: { name?: string; critical?: boolean }): HealthCheck;
}

declare module "fastify" {
  interface FastifyInstance {
    pressure: PressureApi;
  }
}

// ── Built-in signal ─────────────────────────────────────────────────────

/**
 * Event-loop utilisation as saturation.
 *
 * `performance.eventLoopUtilization()` with a previous sample returns the
 * fraction of the interval the loop was busy — already `[0, 1]`, already a
 * ratio, and measured over the window rather than instantaneously. That last
 * part matters: a single lag reading is a spike, while utilisation across a
 * second is load.
 */
function eluSignal(): PressureSignal {
  let previous = performance.eventLoopUtilization();
  return {
    name: "event-loop",
    read() {
      const current = performance.eventLoopUtilization();
      const delta = performance.eventLoopUtilization(current, previous);
      previous = current;
      return delta.utilization;
    },
  };
}

// ── Plugin ──────────────────────────────────────────────────────────────

const clamp = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export const pressurePlugin: FastifyPluginAsync<PressureOptions> = async (
  fastify: FastifyInstance,
  options: PressureOptions,
) => {
  const degradedAt = options.thresholds?.degraded ?? 0.8;
  const saturatedAt = options.thresholds?.saturated ?? 0.95;
  if (degradedAt > saturatedAt) {
    throw new Error(
      `pressurePlugin: thresholds.degraded (${degradedAt}) is above thresholds.saturated ` +
        `(${saturatedAt}) — 'saturated' would be unreachable and the app would never shed.`,
    );
  }

  const signals: PressureSignal[] = [
    ...(options.eventLoopUtilization === false ? [] : [eluSignal()]),
    ...(options.signals ?? []),
  ];

  /** Signals that threw. Logged once each — a broken reader must not spam. */
  const broken = new Set<string>();
  let snapshot: PressureSnapshot = { state: "ok", worst: undefined, signals: {} };

  async function sample(): Promise<void> {
    const values: Record<string, number> = {};
    let worst: { name: string; value: number } | undefined;

    for (const signal of signals) {
      let value = 0;
      try {
        value = clamp(await signal.read());
        broken.delete(signal.name);
      } catch (error) {
        // A failed reader reports 0, never 1: treating "cannot measure" as
        // "saturated" would let one broken probe take the app out of service.
        if (!broken.has(signal.name)) {
          broken.add(signal.name);
          log.warn("pressure signal failed to read; treating as 0", { signal: signal.name, error });
        }
      }
      values[signal.name] = value;
      if (!worst || value > worst.value) worst = { name: signal.name, value };
    }

    // The WORST signal decides. Averaging would let a drained connection pool
    // hide behind three idle ones — the whole point is that any single
    // exhausted resource is enough to stop admitting work.
    const peak = worst?.value ?? 0;
    const next: PressureState =
      peak >= saturatedAt ? "saturated" : peak >= degradedAt ? "degraded" : "ok";

    const previous = snapshot.state;
    snapshot = { state: next, worst, signals: values };
    if (next !== previous) {
      log.info("pressure state changed", { from: previous, to: next, worst });
      options.onStateChange?.(next, snapshot);
    }
  }

  const timer = setInterval(() => {
    void sample();
  }, options.intervalMs ?? 1000);
  timer.unref?.();
  fastify.addHook("onClose", async () => clearInterval(timer));

  const api: PressureApi = {
    state: () => snapshot.state,
    snapshot: () => snapshot,
    register: (signal: PressureSignal) => {
      signals.push(signal);
    },
    shouldShed: () => snapshot.state === "saturated",
    readinessCheck: (checkOptions) => ({
      name: checkOptions?.name ?? "pressure",
      critical: checkOptions?.critical ?? true,
      check: () => snapshot.state !== "saturated",
    }),
  };
  fastify.decorate("pressure", api);

  // ── 503 shedding (opt-in) ──
  if (options.shed) {
    const shedConfig = options.shed === true ? {} : options.shed;
    const statusCode = shedConfig.statusCode ?? 503;
    const retryAfter = shedConfig.retryAfterSeconds ?? 1;
    // Probes are never shed — see the `exclude` note on the option.
    const exempt = ["/_health", "/health", ...(shedConfig.exclude ?? [])];

    fastify.addHook("onRequest", async (request, reply) => {
      if (snapshot.state !== "saturated") return;
      const url = request.url;
      if (exempt.some((prefix) => url.startsWith(prefix))) return;

      // `Retry-After` turns a refusal into a scheduling instruction. Without
      // it a well-behaved client retries immediately and the shed does nothing
      // but add a round trip to the load it was meant to relieve.
      reply.header("Retry-After", String(retryAfter));
      return reply.code(statusCode).send({
        code: "arc.unavailable",
        message: "Server is at capacity — retry shortly.",
        status: statusCode,
      });
    });
  }

  // Take one reading now so a probe arriving before the first interval sees a
  // real answer rather than an optimistic default.
  await sample();
};

/**
 * `fp()`-wrapped so `fastify.pressure` is visible to the whole app rather than
 * trapped in this plugin's encapsulation context — the named export above is
 * the raw plugin, matching every other arc plugin entry.
 */
export default fp(pressurePlugin, {
  name: "arc-pressure",
  fastify: "5.x",
});
