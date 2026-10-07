/**
 * `drain()` and relay health on the outbox module.
 *
 * `drain()` lets a caller AWAIT delivery — `requestDrain()` cannot be awaited — so a
 * test can assert what an event eventually did. The readiness check makes a stalled
 * or poisoned relay visible; before it, nothing in `/_health` could say so.
 */
import { describe, expect, it, vi } from "vitest";
import { type RequestStore, requestContext } from "../../src/context/requestContext.js";
import {
  ARC_EVENT_TRANSPORT,
  createEvent,
  type EventTransport,
  MemoryEventTransport,
} from "../../src/events/EventTransport.js";
import { MemoryOutboxStore } from "../../src/events/outbox.js";
import { createOutboxModule, type OutboxModuleExports } from "../../src/events/outbox-module.js";

const silent = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

function boot(
  transport: EventTransport,
  opts: Partial<Parameters<typeof createOutboxModule>[0]> = {},
  store = new MemoryOutboxStore(),
) {
  const mod = createOutboxModule({ store, transport, ...opts });
  const exp = mod.bootstrap!({
    log: { error: vi.fn() },
    [ARC_EVENT_TRANSPORT]: transport,
  } as never) as OutboxModuleExports;
  return { mod, store, exp };
}

describe("createOutboxModule — drain()", () => {
  it("resolves only after every pending row is delivered AND its handler has run", async () => {
    const transport = new MemoryEventTransport({ logger: silent });
    const handled: number[] = [];
    await transport.subscribe("order:*", async (e) => {
      await new Promise((r) => setTimeout(r, 5));
      handled.push((e.payload as { n: number }).n);
    });
    const { store, exp } = boot(transport, { batchSize: 2 });
    for (let n = 1; n <= 5; n++) await store.save(createEvent("order:created", { n }));

    const result = await exp.drain();

    expect(handled.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result).toMatchObject({ relayed: 5, publishFailed: 0, drained: true });
    expect(result.passes).toBeGreaterThanOrEqual(3); // 2 + 2 + 1, then an empty pass
    expect(await store.getPending(10)).toEqual([]);
  });

  it("delivers a CASCADE — events published by the handlers it ran", async () => {
    const transport = new MemoryEventTransport({ logger: silent });
    const { store, exp } = boot(transport);
    const seen: string[] = [];
    await transport.subscribe("order:created", async () => {
      seen.push("created");
      await store.save(createEvent("order:stock.committed", {}));
    });
    await transport.subscribe("order:stock.committed", async () => {
      seen.push("committed");
    });
    await store.save(createEvent("order:created", {}));

    const result = await exp.drain();

    expect(seen).toEqual(["created", "committed"]);
    expect(result.relayed).toBe(2);
  });

  it("is BOUNDED — a producer that never stops cannot hang the caller", async () => {
    const transport = new MemoryEventTransport({ logger: silent });
    const { store, exp } = boot(transport);
    await transport.subscribe("loop:*", async () => {
      await store.save(createEvent("loop:again", {}));
    });
    await store.save(createEvent("loop:start", {}));

    const result = await exp.drain({ maxPasses: 4 });

    expect(result).toMatchObject({ passes: 4, drained: false });
  });

  it("reports a failed publish instead of calling the queue drained-and-fine", async () => {
    const transport = {
      name: "t",
      publish: vi.fn(async () => {
        throw new Error("broker down");
      }),
    } as unknown as EventTransport;
    const { store, exp } = boot(transport);
    await store.save(createEvent("order:created", {}));

    const result = await exp.drain({ maxPasses: 3 });

    expect(result.publishFailed).toBeGreaterThan(0);
    expect(result.relayed).toBe(0);
  });

  it("runs OUTSIDE the caller's request scope", async () => {
    const transport = new MemoryEventTransport({ logger: silent });
    let scope: RequestStore | undefined;
    await transport.subscribe("order:*", async () => {
      scope = requestContext.get();
    });
    const { store, exp } = boot(transport);
    await store.save(createEvent("order:created", {}));

    const caller: RequestStore = {
      kind: "request",
      requestId: "req-X",
      startTime: 0,
      organizationId: "org-X",
    };
    await requestContext.run(caller, () => exp.drain());

    expect(scope).toBeDefined();
    expect(scope).not.toBe(caller);
    expect(scope?.organizationId).toBeUndefined();
  });

  it("waits for a NUDGED pass that already leased the rows", async () => {
    // The request that wrote the row nudged the relay; its pass claimed the row
    // (lease) and is mid-publish. A drain that only looks for VISIBLE rows sees
    // none and would report drained while the handler has not finished.
    const transport = new MemoryEventTransport({ logger: silent });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const handled: string[] = [];
    await transport.subscribe("order:*", async () => {
      await gate;
      handled.push("done");
    });
    const { store, exp } = boot(transport);
    await store.save(createEvent("order:created", {}));

    exp.requestDrain();
    await new Promise<void>((r) => setImmediate(() => setImmediate(r))); // the nudged pass is now publishing

    const draining = exp.drain();
    setTimeout(release, 20);
    const result = await draining;

    expect(handled, "drain resolved before the nudged pass delivered").toEqual(["done"]);
    expect(result.drained).toBe(true);
  });
});

describe("createOutboxModule — relay health", () => {
  const transport = () =>
    ({ name: "t", publish: vi.fn(async () => {}) }) as unknown as EventTransport;

  it("contributes ONE non-critical readiness check named after the module", () => {
    const { mod } = boot(transport(), { name: "events" });
    expect(mod.healthChecks).toHaveLength(1);
    expect(mod.healthChecks?.[0]).toMatchObject({ name: "events.relay", critical: false });
  });

  it("healthy with an empty queue", async () => {
    const { mod, exp } = boot(transport());
    expect(await exp.health()).toEqual({
      pending: 0,
      deadLetter: 0,
      relayLagMs: null,
      healthy: true,
    });
    expect(await mod.healthChecks![0]!.check()).toBe(true);
  });

  it("UNHEALTHY when the oldest pending event is older than the threshold", async () => {
    const { mod, store, exp } = boot(transport(), { health: { relayLagUnhealthyMs: 1_000 } });
    vi.useFakeTimers({ toFake: ["Date"] });
    await store.save(createEvent("order:created", {}));
    vi.setSystemTime(Date.now() + 60_000); // the relay has not run for a minute
    const h = await exp.health().finally(() => vi.useRealTimers());
    expect(h.pending).toBe(1);
    expect(h.relayLagMs).toBeGreaterThanOrEqual(59_000);
    expect(h.healthy).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const probed = await Promise.resolve(mod.healthChecks![0]!.check()).finally(() =>
      vi.useRealTimers(),
    );
    expect(probed).toBe(false);
  });

  it("a FRESH pending event is not lag", async () => {
    const { store, exp } = boot(transport(), { health: { relayLagUnhealthyMs: 60_000 } });
    await store.save(createEvent("order:created", {}));
    expect((await exp.health()).healthy).toBe(true);
  });

  it("UNHEALTHY with anything dead-lettered, even when nothing is pending", async () => {
    const failing = {
      name: "t",
      publish: vi.fn(async () => {
        throw new Error("poison");
      }),
    } as unknown as EventTransport;
    const { store, exp } = boot(failing, { failurePolicy: () => ({ deadLetter: true }) });
    await store.save(createEvent("order:created", {}));
    await exp.drain({ maxPasses: 2 });

    const h = await exp.health();
    expect(h).toMatchObject({ pending: 0, deadLetter: 1, healthy: false });
  });

  it("a store that cannot report is NOT healthy — unmeasurable is not fine", async () => {
    const store = new MemoryOutboxStore();
    (store as { countByStatus?: unknown }).countByStatus = undefined;
    const { mod, exp } = boot(transport(), {}, store);
    // The message names BOTH methods: it used to say the store implemented
    // "neither", which was false for a store missing only one of them.
    await expect(exp.health()).rejects.toThrow(/needs BOTH countByStatus and oldestPendingAgeMs/);
    await expect(Promise.resolve(mod.healthChecks![0]!.check()).catch(() => false)).resolves.toBe(
      false,
    );
  });

  /**
   * The readiness probe runs on every replica every few seconds, and each
   * reading costs two status counts plus an oldest-pending lookup — at its most
   * expensive during a backlog. Uncached, 50 pods probed every 5 s is ~30
   * outbox queries a second. The probe reuses a reading for `probeCacheMs` and
   * concurrent probes share one; `health()` itself is never cached.
   */
  describe("readiness probe cost", () => {
    const countingStore = () => {
      const store = new MemoryOutboxStore();
      const counts = vi.spyOn(store, "countByStatus");
      return { store, counts };
    };
    const probe = (mod: ReturnType<typeof boot>["mod"]) =>
      Promise.resolve(mod.healthChecks![0]!.check());

    it("reuses one reading across probes inside the window", async () => {
      const { store, counts } = countingStore();
      const { mod } = boot(transport(), { health: { probeCacheMs: 60_000 } }, store);
      for (let i = 0; i < 5; i++) expect(await probe(mod)).toBe(true);
      // ONE reading = two status counts, not ten.
      expect(counts).toHaveBeenCalledTimes(2);
    });

    it("concurrent probes share ONE in-flight reading", async () => {
      const { store, counts } = countingStore();
      const { mod } = boot(transport(), {}, store);
      const results = await Promise.all(Array.from({ length: 10 }, () => probe(mod)));
      expect(results.every(Boolean)).toBe(true);
      expect(counts).toHaveBeenCalledTimes(2);
    });

    it("reads again once the window has passed — a stale answer does not stick", async () => {
      const { store, counts } = countingStore();
      const { mod } = boot(transport(), { health: { probeCacheMs: 1_000 } }, store);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await probe(mod);
        vi.setSystemTime(Date.now() + 1_500);
        await probe(mod);
      } finally {
        vi.useRealTimers();
      }
      expect(counts).toHaveBeenCalledTimes(4);
    });

    it("probeCacheMs: 0 reads on every probe", async () => {
      const { store, counts } = countingStore();
      const { mod } = boot(transport(), { health: { probeCacheMs: 0 } }, store);
      await probe(mod);
      await probe(mod);
      expect(counts).toHaveBeenCalledTimes(4);
    });

    it("the health() export is NEVER cached — an operator asking wants the current answer", async () => {
      const { store, counts } = countingStore();
      const { mod, exp } = boot(transport(), { health: { probeCacheMs: 60_000 } }, store);
      await probe(mod);
      await exp.health();
      await exp.health();
      expect(counts).toHaveBeenCalledTimes(6);
    });

    it("an unmeasurable reading is cached as UNHEALTHY too — no retry storm on a failing store", async () => {
      const store = new MemoryOutboxStore();
      const oldest = vi.spyOn(store, "oldestPendingAgeMs").mockRejectedValue(new Error("db down"));
      const { mod } = boot(transport(), { health: { probeCacheMs: 60_000 } }, store);
      expect(await probe(mod)).toBe(false);
      expect(await probe(mod)).toBe(false);
      expect(oldest).toHaveBeenCalledTimes(1);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      "refuses probeCacheMs: %s at construction",
      (probeCacheMs) => {
        expect(() =>
          createOutboxModule({ store: new MemoryOutboxStore(), health: { probeCacheMs } }),
        ).toThrow(/probeCacheMs must be a non-negative number/);
      },
    );
  });

  it("`health: false` omits the check", () => {
    const { mod } = boot(transport(), { health: false });
    expect(mod.healthChecks).toBeUndefined();
  });
});

describe("createOutboxModule — relay health ALERT", () => {
  const transport = () =>
    ({ name: "t", publish: vi.fn(async () => {}) }) as unknown as EventTransport;

  function bootLogged(opts: Partial<Parameters<typeof createOutboxModule>[0]> = {}) {
    const store = new MemoryOutboxStore();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const t = transport();
    const mod = createOutboxModule({ store, transport: t, ...opts });
    const exp = mod.bootstrap!({ log, [ARC_EVENT_TRANSPORT]: t } as never) as OutboxModuleExports;
    const job = () =>
      (
        mod.scheduledJobs as unknown as () => Array<{
          name: string;
          every: number;
          handler: () => Promise<void>;
        }>
      )().find((j) => j.name.endsWith(".health"));
    return { store, log, exp, job };
  }

  it("is scheduled by default, every 5 minutes", () => {
    expect(bootLogged({ name: "events" }).job()).toMatchObject({
      name: "events.health",
      every: 300_000,
    });
  });

  it("logs OUTBOX_RELAY_LAG at ERROR when the oldest pending event is past the threshold", async () => {
    const { store, log, job } = bootLogged({ health: { relayLagUnhealthyMs: 1_000 } });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await store.save(createEvent("order:created", {}));
      vi.setSystemTime(Date.now() + 60_000);
      await job()!.handler();
    } finally {
      vi.useRealTimers();
    }
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "OUTBOX_RELAY_LAG", outbox: "outbox", pending: 1 }),
      expect.any(String),
    );
  });

  it("logs OUTBOX_DEAD_LETTER at WARN when anything is dead-lettered", async () => {
    const failing = {
      name: "t",
      publish: vi.fn(async () => {
        throw new Error("poison");
      }),
    } as unknown as EventTransport;
    const store = new MemoryOutboxStore();
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const mod = createOutboxModule({
      store,
      transport: failing,
      failurePolicy: () => ({ deadLetter: true }),
    });
    const exp = mod.bootstrap!({
      log,
      [ARC_EVENT_TRANSPORT]: failing,
    } as never) as OutboxModuleExports;
    await store.save(createEvent("order:created", {}));
    await exp.drain({ maxPasses: 2 });

    const job = (
      mod.scheduledJobs as unknown as () => Array<{ name: string; handler: () => Promise<void> }>
    )().find((j) => j.name === "outbox.health");
    await job!.handler();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ marker: "OUTBOX_DEAD_LETTER", deadLetter: 1 }),
      expect.any(String),
    );
  });

  it("is SILENT while healthy", async () => {
    const { log, job } = bootLogged();
    await job()!.handler();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("`alertEveryMs: 0` and `health: false` schedule no alert", () => {
    expect(bootLogged({ health: { alertEveryMs: 0 } }).job()).toBeUndefined();
    expect(bootLogged({ health: false }).job()).toBeUndefined();
  });

  it("a negative interval is refused at construction", () => {
    expect(() =>
      createOutboxModule({ store: new MemoryOutboxStore(), health: { alertEveryMs: -1 } }),
    ).toThrow(/alertEveryMs/);
  });

  it("is a RELAY-kind arm — it runs wherever the relay it watches runs", () => {
    // A `role: 'relay'` process mounts ONLY relay-kind arms. As a default
    // `job`, the alarm was skipped there: in the split topology `role` exists
    // for, the relay ran and its stall alarm ran nowhere.
    const jobs = createOutboxModule({ store: new MemoryOutboxStore() })
      .scheduledJobs as unknown as () => Array<{ name: string; kind?: string }>;
    const byName = Object.fromEntries(jobs().map((j) => [j.name, j.kind]));
    expect(byName["outbox.relay"]).toBe("relay");
    expect(byName["outbox.health"]).toBe("relay");
  });

  it("warns ONCE — never throws every tick — for a store that cannot report counts", async () => {
    const store = new MemoryOutboxStore();
    (store as { countByStatus?: unknown }).countByStatus = undefined;
    const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const t = transport();
    const mod = createOutboxModule({ store, transport: t });
    mod.bootstrap!({ log, [ARC_EVENT_TRANSPORT]: t } as never);
    const job = (
      mod.scheduledJobs as unknown as () => Array<{ name: string; handler: () => Promise<void> }>
    )().find((j) => j.name === "outbox.health");

    // Pre-fix, `health()` threw here on every tick — a schedule failure logged
    // every five minutes, forever, for a store that simply lacks the method.
    await expect(job!.handler()).resolves.toBeUndefined();
    await expect(job!.handler()).resolves.toBeUndefined();
    await expect(job!.handler()).resolves.toBeUndefined();

    const unmeasurable = log.warn.mock.calls.filter(
      ([fields]) => (fields as { marker?: string }).marker === "OUTBOX_HEALTH_UNMEASURABLE",
    );
    expect(unmeasurable).toHaveLength(1);
  });
});
