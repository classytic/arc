/**
 * The outbox admin surface — operator answers that must be TRUE, not merely
 * well-formed.
 *
 * Every assertion here is about a failure that returns 200. A replay that
 * reports success without requeueing, a dead-letter list that renders empty
 * because the store cannot answer, a health check that calls a wedged relay
 * fine, an org gate that reads as scoped while serving every tenant — none of
 * these throw, and all of them tell an operator the opposite of the truth at
 * the moment they are looking because something is already wrong.
 *
 * Driven entirely through `MemoryOutboxStore`: the surface reads a PORT, so the
 * same routes serve Mongo, Postgres and memory. If this file ever needs a
 * database, the module stopped being storage-agnostic.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryOutboxStore } from "../../src/events/outbox.js";
import { createOutboxAdminModule } from "../../src/outbox-admin/module.js";
import { requirePlatformRole, requireRoles } from "../../src/permissions/index.js";

interface RouteLike {
  method: string;
  path: string;
  rawHandler: (req: unknown, reply: unknown) => Promise<unknown>;
}

const platform = requirePlatformRole("platform-ops");

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

const build = (store: MemoryOutboxStore, over: Record<string, unknown> = {}) =>
  createOutboxAdminModule({
    store: store as never,
    permissions: { view: platform },
    ...over,
  });

const deadLettered = () => ({
  event: {
    type: "order:placed",
    payload: { orderId: "o-1", total: 14_999, customerEmail: "buyer@example.com" },
    meta: { id: "evt-1" },
  },
  error: {
    message: "ledger refused the entry",
    code: "LEDGER_REJECT",
    stack: "at post (/srv/x.js:9)",
  },
  attempts: 5,
  firstFailedAt: new Date("2026-01-01T00:00:00Z"),
  lastFailedAt: new Date("2026-01-01T00:05:00Z"),
  handlerName: "ledger-attach",
});

describe("createOutboxAdminModule", () => {
  describe("the operator gate", () => {
    it("refuses a non-platform gate at BOOT, not at the first request", () => {
      /**
       * The jobs vulnerability, ported. These routes are global: an outbox row
       * carries no tenant identity and `getDeadLettered(limit)` takes no
       * filter, so nothing can scope them per request. `requireOrgRole` and a
       * default `requireRoles` both return a bare allow with no policy — they
       * READ as scoped while serving every tenant. Since that is unprovable
       * from outside the check, arc demands the gate declare itself.
       */
      const orgish = requireRoles(["platform-ops"]); // satisfied by an ORG role of that name
      expect(() =>
        createOutboxAdminModule({
          store: new MemoryOutboxStore() as never,
          permissions: { view: orgish },
        }),
      ).toThrow(/must be platform-only/);
    });

    it("checks the replay gate too, not just view", () => {
      expect(() =>
        createOutboxAdminModule({
          store: new MemoryOutboxStore() as never,
          permissions: { view: platform, replay: requireRoles(["ops"]) },
        }),
      ).toThrow(/permissions\.replay must be platform-only/);
    });

    it("accepts an unprovable gate only when the host says it verified it", () => {
      expect(() =>
        createOutboxAdminModule({
          store: new MemoryOutboxStore() as never,
          permissions: { view: requireRoles(["ops"]) },
          allowUnverifiedOperatorPermission: true,
        }),
      ).not.toThrow();
    });

    it("defaults replay to view, but lets it be gated apart", () => {
      const replayGate = requirePlatformRole("platform-sre");
      const mod = build(new MemoryOutboxStore(), {
        permissions: { view: platform, replay: replayGate },
      });
      const perms = (r: RouteLike) => (r as unknown as { permissions: unknown }).permissions;
      expect(perms(route(mod, "POST", "/dead-letter/:id/replay"))).toBe(replayGate);
      expect(perms(route(mod, "GET", "/health"))).toBe(platform);
      expect(perms(route(build(new MemoryOutboxStore()), "POST", "/dead-letter/:id/replay"))).toBe(
        platform,
      );
    });
  });

  describe("health", () => {
    it("is unhealthy on a dead letter", async () => {
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

    it("is unhealthy on a WEDGED relay even with an empty dead-letter queue", async () => {
      /**
       * The number that would otherwise lie. A relay stalled six hours behind a
       * poison row has `deadLetter: 0` — nothing has exhausted its retries yet —
       * so keying `healthy` off that count alone reports fine while the backlog
       * grows. `relayLagMs` was already in the response; nothing consumed it.
       */
      const store = new MemoryOutboxStore();
      vi.spyOn(store, "oldestPendingAgeMs").mockResolvedValue(6 * 60 * 60_000);
      const r = reply();
      await route(build(store), "GET", "/health").rawHandler({}, r.obj);
      expect(r.sent.body).toMatchObject({ deadLetter: 0, healthy: false });
    });

    it("treats a lag under the threshold as healthy, and honours a custom one", async () => {
      const store = new MemoryOutboxStore();
      vi.spyOn(store, "oldestPendingAgeMs").mockResolvedValue(30_000);
      const r = reply();
      await route(build(store), "GET", "/health").rawHandler({}, r.obj);
      expect(r.sent.body).toMatchObject({ healthy: true });

      const strict = build(store, { relayLagUnhealthyMs: 10_000 });
      const r2 = reply();
      await route(strict, "GET", "/health").rawHandler({}, r2.obj);
      expect(r2.sent.body).toMatchObject({ healthy: false });
    });
  });

  describe("dead-letter listing", () => {
    it("withholds the domain payload and the stack by default", async () => {
      /**
       * The payload is the business record — here an order total and a
       * customer's email. Triage needs which event failed, how often, when and
       * why; it does not need the contents, and this surface is read by whoever
       * holds an operator role.
       */
      const store = new MemoryOutboxStore();
      vi.spyOn(store, "getDeadLettered").mockResolvedValue([deadLettered()] as never);
      const r = reply();
      await route(build(store), "GET", "/dead-letter").rawHandler({ query: {} }, r.obj);

      const [row] = (r.sent.body as { events: Record<string, never>[] }).events;
      expect(row!.event).toEqual({ type: "order:placed", meta: { id: "evt-1" } });
      expect(row!.event).not.toHaveProperty("payload");
      expect(row!.error).toEqual({ message: "ledger refused the entry", code: "LEDGER_REJECT" });
      expect(row!.error).not.toHaveProperty("stack");
      // The triage facts survive redaction — otherwise the route is useless.
      expect(row).toMatchObject({ attempts: 5, handlerName: "ledger-attach" });
    });

    it("includes them when the host opts in explicitly", async () => {
      const store = new MemoryOutboxStore();
      vi.spyOn(store, "getDeadLettered").mockResolvedValue([deadLettered()] as never);
      const mod = build(store, { exposePayload: true, exposeStack: true });
      const r = reply();
      await route(mod, "GET", "/dead-letter").rawHandler({ query: {} }, r.obj);

      const [row] = (r.sent.body as { events: Record<string, never>[] }).events;
      expect(row!.event).toHaveProperty("payload");
      expect(row!.error).toHaveProperty("stack");
    });

    it("clamps ?limit into range rather than trusting it", async () => {
      /**
       * The cap is the point: an unbounded read is an export of every failed
       * event from a route meant for triage.
       */
      const store = new MemoryOutboxStore();
      const seen: number[] = [];
      vi.spyOn(store, "getDeadLettered").mockImplementation(async (n: number) => {
        seen.push(n);
        return [];
      });
      const get = route(build(store), "GET", "/dead-letter");

      for (const limit of ["9999", "0", "-5", "abc", undefined]) {
        await get.rawHandler({ query: limit === undefined ? {} : { limit } }, reply().obj);
      }
      expect(seen).toEqual([500, 1, 1, 100, 100]);
    });
  });

  describe("replay", () => {
    it("404s a replay that requeued nothing instead of reporting success", async () => {
      /**
       * THE failure this surface exists to prevent. `requeue` returns false both
       * for an unknown id and for one no longer dead-lettered — in both cases
       * nothing was replayed. Answering 200 would tell an operator the event is
       * on its way while it stays where it was, and they would stop looking.
       */
      const store = new MemoryOutboxStore();
      vi.spyOn(store, "requeue").mockResolvedValue(false);
      const relay = { relay: vi.fn(async () => 0) };

      await expect(
        route(build(store), "POST", "/dead-letter/:id/replay").rawHandler(
          { params: { id: "missing" }, server: serverWithRelay(relay) },
          reply().obj,
        ),
      ).rejects.toThrow(/not found, or not currently dead-lettered/);

      // And it must not drain: a relay tick would make the failure look like work.
      expect(relay.relay).not.toHaveBeenCalled();
    });

    it("requeues, drains, and says the count is the whole batch", async () => {
      const store = new MemoryOutboxStore();
      vi.spyOn(store, "requeue").mockResolvedValue(true);
      const relay = { relay: vi.fn(async () => 3) };
      const r = reply();

      await route(build(store), "POST", "/dead-letter/:id/replay").rawHandler(
        { params: { id: "evt-1" }, server: serverWithRelay(relay) },
        r.obj,
      );

      expect(store.requeue).toHaveBeenCalledWith("evt-1");
      expect(relay.relay).toHaveBeenCalledTimes(1);
      // The note matters: replaying one id delivers everything else pending too,
      // so a bare `relayDelivered: 3` reads as "my event went out three times".
      expect(r.sent.body).toMatchObject({ eventId: "evt-1", requeued: true, relayDelivered: 3 });
      expect((r.sent.body as { note: string }).note).toMatch(/entire drained batch/);
    });
  });

  it("declares a hard dependsOn edge on the outbox module", () => {
    /**
     * The replay route resolves the relay from that module. Without the edge a
     * deployment that forgot the outbox composes fine and fails at the first
     * replay an operator attempts — during an incident, which is the only time
     * anyone opens this page.
     */
    expect(build(new MemoryOutboxStore()).dependsOn).toContain("outbox");
    expect(
      build(new MemoryOutboxStore(), { outboxModuleName: "events-outbox" }).dependsOn,
    ).toContain("events-outbox");
  });
});
