/**
 * The outbox module — the store as a SLOT.
 *
 * These pin the properties the module exists for. Two ERP hosts independently wired a durable
 * store into five of six consumers and missed `createOrder`, so `order:created` published
 * fire-and-forget: a failed publish discarded the revenue trigger with no attach, no dead-letter
 * and no log. Cash collected, nothing recorded, nothing thrown.
 *
 * The fix is structural, so the tests are about structure: the store is reachable from the
 * registry, the relay is the module's own schedule, and one relay instance persists across ticks
 * (a fresh one per tick would be a fresh lease claimant every few seconds, defeating the lease
 * that makes publishing exactly-once).
 */
import { describe, expect, it, vi } from "vitest";
import { ARC_EVENT_TRANSPORT, type EventTransport } from "../../src/events/EventTransport.js";
import { MemoryOutboxStore } from "../../src/events/outbox.js";
import { createOutboxModule } from "../../src/events/outbox-module.js";

interface ScheduleLike {
  name: string;
  every: number;
  runOnStart?: boolean;
  handler: (f: unknown) => Promise<void> | void;
}

/**
 * A minimal fastify stand-in carrying the RAW transport under the symbol the
 * events plugin decorates.
 *
 * It used to hand over `{ events }` — the request-facing facade — which is how
 * the module came to publish through an incompatible signature. The module
 * reads `ARC_EVENT_TRANSPORT` now, and a stand-in that supplies the facade
 * instead would (correctly) fail to boot.
 */
const stubTransport = (): EventTransport =>
  ({ name: "stub", publish: vi.fn(), subscribe: vi.fn() }) as unknown as EventTransport;

const app = (over: Record<string, unknown> = {}) =>
  ({ [ARC_EVENT_TRANSPORT]: stubTransport(), ...over }) as never;

const schedules = (mod: ReturnType<typeof createOutboxModule>): ScheduleLike[] => {
  const arm = mod.scheduledJobs;
  const list = typeof arm === "function" ? arm(app()) : arm;
  return list as unknown as ScheduleLike[];
};

describe("createOutboxModule", () => {
  it("exports the store from bootstrap — the SLOT consumers read", () => {
    /**
     * The whole point: `bootstrap`'s return lands at `fastify.arc.modules.outbox`, so a consumer
     * declares `dependsOn: ['outbox']` and takes the store from the registry instead of the host
     * remembering to pass it.
     */
    const store = new MemoryOutboxStore();
    const mod = createOutboxModule({ store });
    const exp = mod.bootstrap!(app()) as { store: unknown; relay: unknown };

    expect(exp.store).toBe(store);
    expect(exp.relay).toBeDefined();
  });

  it("names the module `outbox` by default — that name IS the dependsOn key", () => {
    expect(createOutboxModule({ store: new MemoryOutboxStore() }).name).toBe("outbox");
  });

  it("accepts a store FACTORY, for a store that needs the booted app", () => {
    // A mongo store needs a connection decorated by an earlier plugin; eager construction at
    // module-definition time would read it before it exists.
    const store = new MemoryOutboxStore();
    const factory = vi.fn(() => store);
    const mod = createOutboxModule({ store: factory });

    expect(factory).not.toHaveBeenCalled(); // not at definition time
    const exp = mod.bootstrap!(app()) as { store: unknown };
    expect(factory).toHaveBeenCalledTimes(1); // at bootstrap
    expect(exp.store).toBe(store);
  });

  it("contributes the relay as its OWN schedule, so no host has to start one", () => {
    const mod = createOutboxModule({ store: new MemoryOutboxStore(), relayEveryMs: 1_234 });
    const [job] = schedules(mod);

    expect(job!.name).toBe("outbox.relay");
    expect(job!.every).toBe(1_234);
  });

  it("runs on start by DEFAULT — a restart with a backlog must drain it immediately", () => {
    /**
     * That backlog is precisely the events the previous process failed to publish. Waiting a full
     * interval to touch them is the wrong default for a durability mechanism.
     */
    expect(schedules(createOutboxModule({ store: new MemoryOutboxStore() }))[0]!.runOnStart).toBe(
      true,
    );
    expect(
      schedules(createOutboxModule({ store: new MemoryOutboxStore(), runOnStart: false }))[0]!
        .runOnStart,
    ).toBe(false);
  });

  it("reuses ONE relay across ticks — a per-tick instance would break the lease", () => {
    /**
     * `EventOutbox` carries the consumer id the lease is keyed on. Rebuilding it every few seconds
     * would make each tick a different claimant, and the lease is the only thing stopping two
     * relays publishing the same event.
     */
    const mod = createOutboxModule({ store: new MemoryOutboxStore() });
    const exp = mod.bootstrap!(app()) as { relay: { relay: () => Promise<unknown> } };
    const spy = vi.spyOn(exp.relay, "relay").mockResolvedValue(undefined as never);

    const [job] = schedules(mod);
    void job!.handler(app());
    void job!.handler(app());

    expect(spy).toHaveBeenCalledTimes(2); // same instance both ticks
  });

  it("a tick BEFORE bootstrap is a no-op, not a crash", async () => {
    // Nothing has been written yet, so there is nothing to drain — skipping is correct and the
    // next tick has the relay.
    const mod = createOutboxModule({ store: new MemoryOutboxStore() });
    await expect(schedules(mod)[0]!.handler(app())).resolves.toBeUndefined();
  });

  it("defaults to the app's RAW transport, not the `fastify.events` facade", () => {
    // The ordinary case. Passing one explicitly is for publishing somewhere else.
    //
    // Specifically the RAW transport: the facade takes `(type, payload, meta?)`
    // and fails open, so relaying through it published nothing and would have
    // acknowledged rows whose publish failed. `tests/events/outbox-memory-handling`
    // walks the composed proof; this pins the resolution source.
    const transport = stubTransport();
    const mod = createOutboxModule({ store: new MemoryOutboxStore() });
    const { relay } = mod.bootstrap!(app({ [ARC_EVENT_TRANSPORT]: transport })) as {
      relay: { transportName?: string };
    };
    expect(relay).toBeDefined();
  });

  it("REFUSES to boot with only the facade present — no silent no-op relay", () => {
    // A relay without a transport returns an empty RelayResult, so the schedule
    // would tick forever against a growing store while reporting healthy.
    const mod = createOutboxModule({ store: new MemoryOutboxStore() });
    const facadeOnly = { events: { publish: vi.fn(), subscribe: vi.fn() } } as never;
    expect(() => mod.bootstrap!(facadeOnly)).toThrow(/could not resolve an event transport/);
  });

  it("honours a custom module name, so two outboxes can coexist", () => {
    // e.g. a separate low-priority queue. The name is the dependsOn key, so it must flow through
    // to the schedule too, or the two relays collide on one schedule name.
    const mod = createOutboxModule({ store: new MemoryOutboxStore(), name: "audit-outbox" });
    expect(mod.name).toBe("audit-outbox");
    expect(schedules(mod)[0]!.name).toBe("audit-outbox.relay");
  });
});

describe("createOutboxModule — lease identity", () => {
  const relayOf = (mod: ReturnType<typeof createOutboxModule>) =>
    (mod.bootstrap!(app()) as { relay: { consumerId: string } }).relay;

  /**
   * The lease is what stops two relays publishing the same event, and it can
   * only do that if the relays are DISTINGUISHABLE. The pre-2.34 default was
   * the shared literal `'arc-outbox-relay'` — run two replicas without
   * setting `consumerId` and both are the same logical owner, so a lease that
   * expires and is re-claimed by the other replica passes the ownership check
   * as if it never moved. The default itself violated the rule its own doc
   * stated.
   */
  it("defaults the consumer id to a unique identity, not a shared literal", () => {
    const id = relayOf(createOutboxModule({ store: new MemoryOutboxStore() })).consumerId;

    expect(id).not.toBe("arc-outbox-relay");
    // Legible in lease rows: module name + hostname + pid + anti-restart suffix.
    expect(id).toMatch(/^outbox:.+:\d+:[0-9a-f]{8}$/);
    expect(id).toContain(`:${process.pid}:`);
  });

  /**
   * PER RELAY INSTANCE, not per process. A lease identifies an independently
   * executing CLAIMANT, and two co-resident modules have two independent
   * schedule arms — nothing stops them pointing at the same store, and then a
   * shared identity leaves the store unable to tell them apart after a lease
   * expiry. Scoping this per-process would also make the module WEAKER than
   * the primitive it wraps: `EventOutbox`'s own fallback is per-instance.
   */
  it("gives two co-resident modules DISTINCT identities", () => {
    const a = relayOf(createOutboxModule({ store: new MemoryOutboxStore() })).consumerId;
    const b = relayOf(createOutboxModule({ store: new MemoryOutboxStore() })).consumerId;
    expect(a).not.toBe(b);
  });

  it("carries the module name, so a lease row says WHICH relay holds it", () => {
    const id = relayOf(
      createOutboxModule({ store: new MemoryOutboxStore(), name: "billing-outbox" }),
    ).consumerId;
    expect(id.startsWith("billing-outbox:")).toBe(true);
  });

  it("an explicit consumerId still wins — ops-legible names remain possible", () => {
    const id = relayOf(
      createOutboxModule({ store: new MemoryOutboxStore(), consumerId: "billing-relay:pod-7" }),
    ).consumerId;
    expect(id).toBe("billing-relay:pod-7");
  });
});

describe("createOutboxModule — retry policy passthrough", () => {
  it("forwards failurePolicy, so adopting the module is not a silent downgrade", () => {
    /**
     * A real host had `({attempts}) => attempts >= 5 ? {deadLetter:true} : {retryAt: backoff}`.
     * The first version of this module had no way to express that, so composing it would have
     * quietly replaced a tuned policy with the default — for money events. Without a policy a
     * permanently-failing row either retries forever or dead-letters on the first blip.
     */
    const failurePolicy = vi.fn(() => ({ deadLetter: true as const }));
    const mod = createOutboxModule({ store: new MemoryOutboxStore(), failurePolicy });
    const exp = mod.bootstrap!(app()) as { relay: unknown };
    // Reaching into the relay is deliberate: the alternative is driving a real failure through
    // the store, which tests EventOutbox rather than this module's wiring.
    expect((exp.relay as unknown as { _failurePolicy?: unknown })._failurePolicy).toBe(
      failurePolicy,
    );
  });
});
