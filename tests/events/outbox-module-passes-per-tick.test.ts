/**
 * `maxPassesPerTick` — one scheduled tick (or one `requestDrain`) may run several
 * relay passes while each comes back FULL and makes progress. Default 1 keeps the
 * one-batch-per-tick behaviour; a full batch of failures stops the loop.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ARC_EVENT_TRANSPORT,
  createEvent,
  type EventTransport,
} from "../../src/events/EventTransport.js";
import { MemoryOutboxStore } from "../../src/events/outbox.js";
import {
  createOutboxModule,
  type OutboxModuleExports,
  type OutboxModuleOptions,
} from "../../src/events/outbox-module.js";

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

async function boot(
  rows: number,
  opts: Partial<OutboxModuleOptions> = {},
  publish: (...args: unknown[]) => Promise<void> = async () => {},
) {
  const store = new MemoryOutboxStore();
  for (let i = 0; i < rows; i++) await store.save(createEvent("order:created", { n: i }));
  const publishSpy = vi.fn(publish);
  const transport = { name: "t", publish: publishSpy } as unknown as EventTransport;
  const mod = createOutboxModule({ store, transport, batchSize: 100, runOnStart: false, ...opts });
  const exp = mod.bootstrap!({
    log: { error: vi.fn() },
    [ARC_EVENT_TRANSPORT]: transport,
  } as never) as OutboxModuleExports;
  const relayBatch = vi.spyOn(exp.relay, "relayBatch");
  const jobs = (
    mod.scheduledJobs as unknown as () => Array<{ name: string; handler: () => Promise<void> }>
  )();
  const relayJob = jobs.find((j) => j.name === "outbox.relay");
  if (!relayJob) throw new Error("relay job missing");
  return { store, exp, relayBatch, publishSpy, runTick: relayJob.handler };
}

describe("createOutboxModule — maxPassesPerTick", () => {
  it("drains 250 rows in ONE tick with batchSize 100 and maxPassesPerTick 5 (3 passes + 1 empty claim)", async () => {
    const { store, relayBatch, publishSpy, runTick } = await boot(250, { maxPassesPerTick: 5 });
    await runTick();
    // 100, 100, 50, then a claim that finds nothing ends the loop.
    expect(relayBatch).toHaveBeenCalledTimes(4);
    expect(publishSpy).toHaveBeenCalledTimes(250);
    expect(await store.getPending(1000)).toEqual([]);
  });

  it("defaults to one pass per tick (100 of 250 relayed)", async () => {
    const { store, relayBatch, publishSpy, runTick } = await boot(250);
    await runTick();
    expect(relayBatch).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(100);
    expect(await store.getPending(1000)).toHaveLength(150);
  });

  it("stops after one pass when every publish fails (no spin during an outage)", async () => {
    const { relayBatch, runTick } = await boot(250, { maxPassesPerTick: 5 }, async () => {
      throw new Error("transport down");
    });
    await runTick();
    expect(relayBatch).toHaveBeenCalledTimes(1);
  });

  it("a store that caps one claim below batchSize still drains in one tick (G-PLAT-1)", async () => {
    // A repository-backed store whose page maxLimit (mongokit default 100) clamps the claim:
    // a pass of 100 with batchSize 500 is NOT the end of the backlog.
    const { store, relayBatch, publishSpy, runTick } = await boot(1_200, {
      batchSize: 500,
      maxPassesPerTick: 20,
    });
    const claim = store.claimPendingFenced.bind(store);
    store.claimPendingFenced = (o) => claim({ ...o, limit: Math.min(o?.limit ?? 100, 100) });
    await runTick();
    expect(publishSpy).toHaveBeenCalledTimes(1_200);
    expect(await store.getPending(5_000)).toEqual([]);
    expect(relayBatch).toHaveBeenCalledTimes(13);
  });

  it("stops when the cap is reached", async () => {
    const { relayBatch, store, runTick } = await boot(250, { maxPassesPerTick: 2 });
    await runTick();
    expect(relayBatch).toHaveBeenCalledTimes(2);
    expect(await store.getPending(1000)).toHaveLength(50);
  });

  it("drain() waits for a multi-pass tick that is in flight", async () => {
    const { exp, relayBatch, runTick } = await boot(250, { maxPassesPerTick: 5 });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = Object.getPrototypeOf(exp.relay).relayBatch.bind(exp.relay);
    relayBatch.mockImplementationOnce(async () => {
      await gate;
      return original();
    });
    const tickDone = runTick();
    const drained = exp.drain();
    await tick();
    release();
    await tickDone;
    const total = await drained;
    // The tick's 3 passes ran first; drain then found nothing visible.
    expect(total.drained).toBe(true);
    expect(total.relayed).toBe(0);
  });

  it("requestDrain loops too", async () => {
    const { store, exp, relayBatch } = await boot(250, { maxPassesPerTick: 5 });
    exp.requestDrain();
    await exp.drain();
    expect(relayBatch.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await store.getPending(1000)).toEqual([]);
    // The nudge alone cleared the backlog: drain's single pass relayed nothing.
    relayBatch.mockClear();
    exp.requestDrain();
    await tick();
    expect(relayBatch).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects maxPassesPerTick %s",
    (bad) => {
      expect(() =>
        createOutboxModule({
          store: new MemoryOutboxStore(),
          maxPassesPerTick: bad,
        }),
      ).toThrow(/maxPassesPerTick must be an integer >= 1/);
    },
  );

  it("exposes the relay batch size", () => {
    const transport = { name: "t", publish: vi.fn() } as unknown as EventTransport;
    const mod = createOutboxModule({ store: new MemoryOutboxStore(), transport, batchSize: 7 });
    const exp = mod.bootstrap!({
      log: { error: vi.fn() },
      [ARC_EVENT_TRANSPORT]: transport,
    } as never) as OutboxModuleExports;
    expect(exp.relay.batchSize).toBe(7);
  });
});
