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
import { MemoryOutboxStore } from "../../src/events/outbox.js";
import { createOutboxModule } from "../../src/events/outbox-module.js";

interface ScheduleLike {
  name: string;
  every: number;
  runOnStart?: boolean;
  handler: (f: unknown) => Promise<void> | void;
}

/** A minimal fastify stand-in — the module only reads `events` off it. */
const app = (over: Record<string, unknown> = {}) => ({ events: undefined, ...over }) as never;

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

  it("defaults the transport to the app's own `events`", () => {
    // The ordinary case. Passing one explicitly is for publishing somewhere else.
    const events = { publish: vi.fn(), subscribe: vi.fn() };
    const mod = createOutboxModule({ store: new MemoryOutboxStore() });
    expect(() => mod.bootstrap!(app({ events }))).not.toThrow();
  });

  it("honours a custom module name, so two outboxes can coexist", () => {
    // e.g. a separate low-priority queue. The name is the dependsOn key, so it must flow through
    // to the schedule too, or the two relays collide on one schedule name.
    const mod = createOutboxModule({ store: new MemoryOutboxStore(), name: "audit-outbox" });
    expect(mod.name).toBe("audit-outbox");
    expect(schedules(mod)[0]!.name).toBe("audit-outbox.relay");
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
    const exp = mod.bootstrap!({ events: undefined } as never) as { relay: unknown };
    // Reaching into the relay is deliberate: the alternative is driving a real failure through
    // the store, which tests EventOutbox rather than this module's wiring.
    expect((exp.relay as unknown as { _failurePolicy?: unknown })._failurePolicy).toBe(
      failurePolicy,
    );
  });
});
