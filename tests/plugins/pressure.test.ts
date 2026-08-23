/**
 * Admission control: the policy, not the plumbing.
 *
 * Every test drives signals by hand. The subject is what arc DECIDES given a
 * set of saturation readings — combine, threshold, transition, degrade safely —
 * and a test that waited on real event-loop load would be measuring the runner
 * instead, which is the flake shape `wiki/testing.md` names.
 *
 * Sampling is driven explicitly (`intervalMs` is long, and the plugin takes one
 * reading at boot) so nothing here waits on a timer.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import pressurePlugin, { type PressureSignal } from "../../src/plugins/pressure.js";
import { waitFor } from "../../src/testing/mocks.js";

const live: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of live.reverse()) await app.close().catch(() => {});
  live.length = 0;
});

/** A signal whose value the test sets. */
function knob(name: string, value = 0) {
  const signal: PressureSignal & { set(v: number): void } = {
    name,
    read: () => value,
    set(v: number) {
      value = v;
    },
  };
  return signal;
}

async function appWith(options: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  live.push(app);
  await app.register(pressurePlugin, {
    eventLoopUtilization: false, // measured separately; keeps these deterministic
    intervalMs: 60_000, // never fires during a test — boot sample only
    ...options,
  } as never);
  await app.ready();
  return app;
}

describe("pressure — state from signals", () => {
  it("is ok below the degraded threshold", async () => {
    const app = await appWith({ signals: [knob("db", 0.5)] });
    expect(app.pressure.state()).toBe("ok");
    expect(app.pressure.shouldShed()).toBe(false);
  });

  it("degrades at the threshold", async () => {
    const app = await appWith({ signals: [knob("db", 0.8)] });
    expect(app.pressure.state()).toBe("degraded");
    // Degraded still SERVES — shedding here would refuse traffic the app can
    // still handle, which is the failure mode of a too-eager limiter.
    expect(app.pressure.shouldShed()).toBe(false);
  });

  it("saturates at the threshold and sheds", async () => {
    const app = await appWith({ signals: [knob("db", 0.95)] });
    expect(app.pressure.state()).toBe("saturated");
    expect(app.pressure.shouldShed()).toBe(true);
  });

  it("the WORST signal decides — an exhausted resource is not averaged away", async () => {
    // Three idle signals and one exhausted. A mean would read 0.25 and admit
    // work the drained pool cannot serve.
    const app = await appWith({
      signals: [knob("a", 0), knob("b", 0), knob("c", 0), knob("pool", 1)],
    });

    expect(app.pressure.state()).toBe("saturated");
    expect(app.pressure.snapshot().worst).toEqual({ name: "pool", value: 1 });
  });

  it("reports every signal's value in the snapshot", async () => {
    const app = await appWith({ signals: [knob("a", 0.1), knob("b", 0.7)] });
    expect(app.pressure.snapshot().signals).toEqual({ a: 0.1, b: 0.7 });
  });
});

describe("pressure — degrading safely", () => {
  it("a THROWING signal reports 0, never 1", async () => {
    // A broken thermometer is not a fire. Treating an unreadable probe as
    // saturated would let one failing reader take the app out of service.
    const app = await appWith({
      signals: [
        {
          name: "broken",
          read: () => {
            throw new Error("probe exploded");
          },
        },
      ],
    });

    expect(app.pressure.state()).toBe("ok");
    expect(app.pressure.snapshot().signals.broken).toBe(0);
  });

  it("a broken signal does not hide a healthy one", async () => {
    const app = await appWith({
      signals: [
        {
          name: "broken",
          read: () => {
            throw new Error("nope");
          },
        },
        knob("pool", 1),
      ],
    });

    expect(app.pressure.state()).toBe("saturated");
  });

  it("clamps out-of-range and non-finite readings", async () => {
    // A signal author computing `borrowed / size` on an empty pool produces
    // NaN; a miscount produces 1.4. Neither should reach the policy.
    const app = await appWith({
      signals: [knob("over", 4), knob("under", -2), knob("nan", Number.NaN)],
    });

    const { signals } = app.pressure.snapshot();
    expect(signals).toEqual({ over: 1, under: 0, nan: 0 });
  });
});

describe("pressure — configuration", () => {
  it("REFUSES thresholds that make saturation unreachable", async () => {
    // degraded above saturated means the app degrades and never sheds — a
    // config that silently disables the whole point. Boot-fatal, not a warn.
    const app = Fastify({ logger: false });
    live.push(app);

    await expect(
      app
        .register(pressurePlugin, {
          thresholds: { degraded: 0.9, saturated: 0.5 },
        } as never)
        .ready(),
    ).rejects.toThrow(/would be unreachable/);
  });

  it("custom thresholds are honoured", async () => {
    const app = await appWith({
      signals: [knob("db", 0.3)],
      thresholds: { degraded: 0.2, saturated: 0.25 },
    });
    expect(app.pressure.state()).toBe("saturated");
  });

  it("onStateChange fires on TRANSITIONS, not on every sample", async () => {
    const onStateChange = vi.fn();
    const db = knob("db", 0);
    // A fast interval plus a CONDITION wait: the test waits for the state to
    // move, never for a duration.
    const app = await appWith({ signals: [db], onStateChange, intervalMs: 10 });

    expect(onStateChange).not.toHaveBeenCalled(); // boot sampled `ok` — no change

    db.set(1);
    await waitFor(() => app.pressure.state() === "saturated", { label: "ok -> saturated" });
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0]?.[0]).toBe("saturated");

    // Many more samples at the SAME state must not fire again.
    const before = onStateChange.mock.calls.length;
    await waitFor(() => app.pressure.snapshot().signals.db === 1, { label: "further samples" });
    expect(onStateChange.mock.calls.length).toBe(before);
  });

  it("a signal registered AFTER boot participates in the next sample", async () => {
    const app = await appWith({ signals: [], intervalMs: 10 });
    expect(app.pressure.state()).toBe("ok");

    app.pressure.register(knob("late", 1));

    await waitFor(() => app.pressure.state() === "saturated", { label: "late signal counted" });
    expect(app.pressure.snapshot().worst).toEqual({ name: "late", value: 1 });
  });
});
