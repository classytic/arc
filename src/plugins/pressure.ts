/**
 * Admission control — ONE place that decides "are we saturated?".
 *
 * Arc already sheds on event-loop lag (`@fastify/under-pressure`), but lag is
 * LATE: by the time the loop is behind, the work causing it is already
 * admitted. What actually saturates a backend — a drained pool, an undrained
 * queue, an outbox falling behind — is invisible to it. Rate limiting is a
 * different axis: it bounds request FREQUENCY, this bounds concurrent
 * EXPENSIVE WORK.
 *
 * Signals are REGISTERED, not enumerated, because only ELU has a source arc
 * can read today — no kit exposes pool stats, no queue exposes depth. Arc owns
 * the DECISION; signals come from whoever can produce them.
 *
 * `read()` returns SATURATION in [0,1]. Each signal normalises itself: 90% of
 * a pool is nearly fatal, 90% ELU is merely busy, and only the signal's author
 * knows which.
 *
 * @example
 * ```typescript
 * await app.register(pressurePlugin, {
 *   signals: [{ name: 'db-pool', read: () => pool.borrowed / pool.size }],
 *   shed: true,
 * });
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
 * A throwing `read()` reports 0, never 1 — a broken thermometer is not a fire.
 * Logged once per signal, not per sample.
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
   * Refuse with 503 while `saturated`. Default OFF — arc cannot know which
   * routes are sheddable, and refusing a checkout because a dashboard drained
   * the pool is worse than serving it slowly.
   *
   * `exclude` matches `request.url` by prefix. Health routes are ALWAYS exempt:
   * a 503 on `/_health/ready` reads as "process dead", not "process full".
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
   * A readiness check for `healthPlugin({ checks })`. NOT auto-registered:
   * flipping readiness pulls the instance from its load balancer — right in a
   * fleet, a self-inflicted outage for a single instance. Unhealthy only at
   * `saturated`; `degraded` still serves.
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
 * Event-loop utilisation as saturation — already a [0,1] ratio, and measured
 * ACROSS the interval rather than instantaneously: one lag reading is a spike,
 * utilisation over a second is load.
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
