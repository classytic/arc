/**
 * Single-flight passes and lease-loss back-off in `createOutboxModule` (G-LOAD-2).
 *
 * A drain requested while a pass was running started a SECOND pass at once,
 * because the coalescing flag reset when a pass started, not when it ended. On a
 * slow store the second pass re-claimed the first one's expired rows, both ran
 * the handlers, the older ack failed, and every failure logged an error — a
 * livelock of ownership mismatches. Now: one pass at a time per lane, a request
 * during a pass queues exactly one follow-up, and a pass that loses leases logs
 * one warning and backs off.
 */
import { OutboxOwnershipError } from "@classytic/primitives/outbox";
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

async function boot(
  store: MemoryOutboxStore,
  publish: () => Promise<void>,
  opts: Partial<OutboxModuleOptions> = {},
) {
  const transport = { name: "t", publish: vi.fn(publish) } as unknown as EventTransport;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const mod = createOutboxModule({ store, transport, runOnStart: false, ...opts });
  const exp = mod.bootstrap!({
    log,
    [ARC_EVENT_TRANSPORT]: transport,
  } as never) as OutboxModuleExports;
  // Overlap probe: how many relayBatch calls are in flight at once.
  let active = 0;
  let maxActive = 0;
  const original = exp.relay.relayBatch.bind(exp.relay);
  const relayBatch = vi.fn(async (...args: Parameters<typeof original>) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      return await original(...args);
    } finally {
      active--;
    }
  });
  exp.relay.relayBatch = relayBatch;
  const relayJob = (
    mod.scheduledJobs as unknown as () => Array<{ name: string; handler: () => Promise<void> }>
  )().find((j) => j.name === "outbox.relay");
  if (!relayJob) throw new Error("relay job missing");
  return {
    exp,
    log,
    relayBatch,
    publish: transport.publish as ReturnType<typeof vi.fn>,
    runTick: relayJob.handler,
    maxActive: () => maxActive,
    close: () => (mod.onClose as ((f: unknown) => Promise<void> | void) | undefined)?.({}),
  };
}

async function seed(store: MemoryOutboxStore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await store.save(createEvent("order:created", { n: i }));
}

describe("createOutboxModule — single-flight passes", () => {
  it("drains requested during a pass never overlap it, and queue exactly one follow-up", async () => {
    const store = new MemoryOutboxStore();
    await seed(store, 20);
    const h = await boot(store, () => sleep(30), { batchSize: 5 });

    h.exp.requestDrain();
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalled(), { timeout: 2_000 });
    // Several requests land while the first pass is still publishing.
    h.exp.requestDrain();
    await tick();
    h.exp.requestDrain();
    await tick();
    h.exp.requestDrain();

    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(10), { timeout: 5_000 });
    await sleep(100);

    expect(h.maxActive()).toBe(1);
    expect(h.relayBatch).toHaveBeenCalledTimes(2); // the pass + ONE follow-up
    expect(await store.countByStatus("delivered")).toBe(10);
  });

  it("a scheduled tick does not overlap a requested pass", async () => {
    const store = new MemoryOutboxStore();
    await seed(store, 10);
    const h = await boot(store, () => sleep(30), { batchSize: 5 });

    h.exp.requestDrain();
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalled(), { timeout: 2_000 });
    await h.runTick();

    expect(h.maxActive()).toBe(1);
    expect(await store.countByStatus("delivered")).toBe(10);
  });
});

describe("createOutboxModule — lease-loss back-off", () => {
  /** A store whose every ack reports a lost lease, as a re-claimed row would. */
  function lostLeaseStore(): MemoryOutboxStore {
    const store = new MemoryOutboxStore();
    store.acknowledge = async (eventId: string) => {
      throw new OutboxOwnershipError(eventId, "me", "someone-else");
    };
    return store;
  }

  it("logs ONE warning with counts per pass, not an error per row, and backs off", async () => {
    const store = lostLeaseStore();
    await seed(store, 10);
    const h = await boot(store, async () => {}, { batchSize: 5, maxPassesPerTick: 5 });

    h.exp.requestDrain();
    await vi.waitFor(() => expect(h.relayBatch).toHaveBeenCalledTimes(1));
    await tick();
    // Hammering requests and ticks during the back-off claims nothing.
    for (let i = 0; i < 5; i++) {
      h.exp.requestDrain();
      await tick();
    }
    await h.runTick();
    expect(h.relayBatch).toHaveBeenCalledTimes(1);

    const lost = h.log.warn.mock.calls.filter(
      ([f]) => (f as { marker?: string }).marker === "OUTBOX_LEASE_LOST",
    );
    expect(lost).toHaveLength(1);
    expect(lost[0]?.[0]).toMatchObject({
      outbox: "outbox",
      ownershipMismatches: 5,
      backoffMs: 1_000,
    });
    const perRow = h.log.error.mock.calls.filter(
      ([f]) => (f as { kind?: string }).kind === "ownership_mismatch",
    );
    expect(perRow).toEqual([]);

    // The request that arrived during the back-off runs once it ends, and a
    // second consecutive loss doubles the back-off.
    await vi.waitFor(() => expect(h.relayBatch).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    await vi.waitFor(() =>
      expect(
        h.log.warn.mock.calls.filter(
          ([f]) => (f as { marker?: string }).marker === "OUTBOX_LEASE_LOST",
        )[1]?.[0],
      ).toMatchObject({ backoffMs: 2_000 }),
    );
    await h.close();
  });

  it("a custom onError still sees each mismatch", async () => {
    const store = lostLeaseStore();
    await seed(store, 3);
    const onError = vi.fn();
    const h = await boot(store, async () => {}, { onError });
    await h.runTick();
    expect(onError.mock.calls.filter(([i]) => i.kind === "ownership_mismatch")).toHaveLength(3);
    await h.close();
  });
});
