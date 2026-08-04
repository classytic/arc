/**
 * The outbox admin surface — operator answers that must be TRUE, not merely
 * well-formed.
 *
 * Every assertion here is about a failure that returns 200. A replay that
 * reports success without requeueing, a dead-letter list that renders empty
 * because the store cannot answer, a health check that calls a backlog fine —
 * none of these throw, and all of them tell an operator the opposite of the
 * truth at the moment they are looking because something is already wrong.
 *
 * Driven entirely through `MemoryOutboxStore`: the surface reads a PORT, so the
 * same routes serve Mongo, Postgres and memory. If this file ever needs a
 * database, the module stopped being storage-agnostic.
 */
import { describe, expect, it, vi } from "vitest";
import { createOutboxAdminModule } from "../../src/events/outbox-admin-module.js";
import { MemoryOutboxStore } from "../../src/events/outbox.js";

interface RouteLike {
  method: string;
  path: string;
  rawHandler: (req: unknown, reply: unknown) => Promise<unknown>;
}

const allow = (() => true) as never;

const routesOf = (mod: ReturnType<typeof createOutboxAdminModule>): RouteLike[] => {
  const arm = mod.resources;
  const list = (typeof arm === "function" ? arm(undefined as never) : arm) as unknown as {
    routes: RouteLike[];
  }[];
  return list[0]!.routes;
};

const route = (mod: ReturnType<typeof createOutboxAdminModule>, method: string, path: string) => {
  const r = routesOf(mod).find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r;
};

/** Captures what the handler sent, the way fastify's reply would. */
const reply = () => {
  const sent: { body?: unknown } = {};
  return { sent, obj: { send: (b: unknown) => ((sent.body = b), b) } as never };
};

/** A server stand-in exposing one relay through the module registry. */
const serverWithRelay = (relay: { relay: () => Promise<number> }) =>
  ({ arc: { modules: { outbox: { relay } } } }) as never;

const build = (store: MemoryOutboxStore) =>
  createOutboxAdminModule({ store: store as never, permissions: { view: allow } });

describe("createOutboxAdminModule", () => {
  it("reports a dead-lettered event as unhealthy", async () => {
    /**
     * `healthy` keys off the dead-letter count, not the pending one. A pending
     * backlog is a relay running behind — real, but self-correcting and already
     * reported by `relayLagMs`. A dead-lettered event is one that nothing will
     * ever retry: the money move or access grant behind it is simply lost.
     */
    const store = new MemoryOutboxStore();
    const mod = build(store);
    const r = reply();

    await route(mod, "GET", "/health").rawHandler({}, r.obj);
    expect(r.sent.body).toMatchObject({ deadLetter: 0, healthy: true });

    vi.spyOn(store, "countByStatus").mockImplementation(async (s) =>
      s === "dead_letter" ? 1 : 0,
    );
    const r2 = reply();
    await route(mod, "GET", "/health").rawHandler({}, r2.obj);
    expect(r2.sent.body).toMatchObject({ deadLetter: 1, healthy: false });
  });

  it("404s a replay that requeued nothing instead of reporting success", async () => {
    /**
     * THE failure this surface exists to prevent. `requeue` returns false both
     * for an unknown id and for one no longer dead-lettered — in both cases
     * nothing was replayed. Answering 200 would tell an operator the event is
     * on its way while it stays exactly where it was, and they would stop
     * looking.
     */
    const store = new MemoryOutboxStore();
    vi.spyOn(store, "requeue").mockResolvedValue(false);
    const mod = build(store);
    const relay = { relay: vi.fn(async () => 0) };

    await expect(
      route(mod, "POST", "/dead-letter/:id/replay").rawHandler(
        { params: { id: "missing" }, server: serverWithRelay(relay) },
        reply().obj,
      ),
    ).rejects.toThrow(/not found, or not currently dead-lettered/);

    // And it must not drain: a relay tick would make the failure look like work.
    expect(relay.relay).not.toHaveBeenCalled();
  });

  it("requeues then drains, reporting what was delivered", async () => {
    const store = new MemoryOutboxStore();
    vi.spyOn(store, "requeue").mockResolvedValue(true);
    const mod = build(store);
    const relay = { relay: vi.fn(async () => 3) };
    const r = reply();

    await route(mod, "POST", "/dead-letter/:id/replay").rawHandler(
      { params: { id: "evt-1" }, server: serverWithRelay(relay) },
      r.obj,
    );

    expect(store.requeue).toHaveBeenCalledWith("evt-1");
    expect(relay.relay).toHaveBeenCalledTimes(1);
    expect(r.sent.body).toEqual({ eventId: "evt-1", requeued: true, relayDelivered: 3 });
  });

  it("clamps ?limit into range rather than trusting it", async () => {
    /**
     * The cap is the point: an unbounded dead-letter read is an export of every
     * failed event with its payload, from a route meant for triage.
     */
    const store = new MemoryOutboxStore();
    const seen: number[] = [];
    vi.spyOn(store, "getDeadLettered").mockImplementation(async (n: number) => {
      seen.push(n);
      return [];
    });
    const mod = build(store);
    const get = route(mod, "GET", "/dead-letter");

    for (const limit of ["9999", "0", "-5", "abc", undefined]) {
      await get.rawHandler({ query: limit === undefined ? {} : { limit } }, reply().obj);
    }

    // clamped high, clamped low, clamped low, non-numeric → default, absent → default
    expect(seen).toEqual([500, 1, 1, 100, 100]);
  });

  it("declares a hard dependsOn edge on the outbox module", () => {
    /**
     * The replay route resolves the relay from that module. Without the edge a
     * deployment that forgot the outbox composes fine and fails at the first
     * replay an operator attempts — during an incident, which is the only time
     * anyone opens this page.
     */
    expect(build(new MemoryOutboxStore()).dependsOn).toContain("outbox");
    const named = createOutboxAdminModule({
      store: new MemoryOutboxStore() as never,
      permissions: { view: allow },
      outboxModuleName: "events-outbox",
    });
    expect(named.dependsOn).toContain("events-outbox");
  });

  it("defaults replay permission to view, but lets it be gated apart", () => {
    const store = new MemoryOutboxStore();
    const replayGate = (() => true) as never;
    const mod = createOutboxAdminModule({
      store: store as never,
      permissions: { view: allow, replay: replayGate },
    });
    const perms = (r: RouteLike) => (r as unknown as { permissions: unknown }).permissions;
    expect(perms(route(mod, "POST", "/dead-letter/:id/replay"))).toBe(replayGate);
    expect(perms(route(mod, "GET", "/health"))).toBe(allow);
    // Omitted → replay inherits view.
    expect(perms(route(build(store), "POST", "/dead-letter/:id/replay"))).toBe(allow);
  });
});
