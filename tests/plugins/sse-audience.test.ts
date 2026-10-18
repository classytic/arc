/**
 * SSE keyed audience routing — `audience(event)` resolves recipient keys and
 * delivery is a map lookup, with org-scoping + `filter` still applied to the
 * looked-up connections (defense in depth). Real HTTP: SSE hijacks the socket,
 * so `inject()` cannot read the stream.
 */

import http from "node:http";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import { RedisEventTransport, type RedisLike } from "../../src/events/transports/redis.js";
import ssePlugin, { type SSEOptions } from "../../src/plugins/sse.js";
import { waitFor } from "../../src/testing/mocks.js";

interface Client {
  body: () => string;
  close: () => void;
}

/** Open a stream as `user` (header-driven scope); resolves once the response head arrives. */
function connect(port: number, headers: Record<string, string>): Promise<Client> {
  return new Promise((resolve, reject) => {
    let body = "";
    const req = http.get({ host: "127.0.0.1", port, path: "/events/stream", headers }, (res) => {
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("error", () => {});
      resolve({ body: () => body, close: () => req.destroy() });
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
  });
}

const as = (user: string, extra: Record<string, string> = {}) => ({ "x-user": user, ...extra });

const commsAudience: NonNullable<SSEOptions["audience"]> = (event) =>
  event.type.startsWith("comms.")
    ? ((event.payload as { participantIds?: string[] }).participantIds ?? [])
    : null;

async function buildApp(
  options: Partial<SSEOptions> = {},
  transport?: RedisEventTransport,
): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({ logger: false });
  await app.register(eventPlugin, transport ? { transport } : {});
  app.addHook("onRequest", async (request) => {
    const user = request.headers["x-user"];
    const org = request.headers["x-org"];
    (request as unknown as { scope: unknown }).scope =
      typeof user !== "string"
        ? { kind: "public" }
        : typeof org === "string"
          ? { kind: "member", userId: user, userRoles: [], organizationId: org, orgRoles: [] }
          : { kind: "authenticated", userId: user };
  });
  await app.register(ssePlugin, {
    requireAuth: false,
    heartbeat: 60_000,
    audience: commsAudience,
    ...options,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, port: (app.server.address() as { port: number }).port };
}

/** A broadcast every connection receives; once seen, every earlier frame has been written. */
async function drain(app: FastifyInstance, clients: Client[]): Promise<void> {
  const marker = `m${Math.random().toString(36).slice(2)}`;
  await app.events.publish("sys.marker", { marker });
  await waitFor(() => clients.every((c) => c.body().includes(marker)), {
    label: "broadcast marker on every stream",
  });
}

describe("SSE keyed audience routing", () => {
  const apps: FastifyInstance[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  });

  async function open(
    port: number,
    app: FastifyInstance,
    headers: Record<string, string>,
  ): Promise<Client> {
    const before = app.sseStats().connections;
    const client = await connect(port, headers);
    clients.push(client);
    await waitFor(() => app.sseStats().connections > before, { label: "connection indexed" });
    return client;
  }

  it("delivers only to the audience, running the filter only on those connections", async () => {
    const filter = vi.fn(() => true);
    const { app, port } = await buildApp({ filter });
    apps.push(app);
    const a = await open(port, app, as("a"));
    const b = await open(port, app, as("b"));
    const c = await open(port, app, as("c"));

    filter.mockClear();
    await app.events.publish("comms.message.sent", { participantIds: ["a", "b"], seq: 1 });
    expect(filter).toHaveBeenCalledTimes(2);
    await drain(app, [a, b, c]);

    expect(a.body()).toContain("event: comms.message.sent");
    expect(b.body()).toContain("event: comms.message.sent");
    expect(c.body()).not.toContain("comms.message.sent");
    expect(app.sseStats()).toEqual({ connections: 3, keys: 3 });
  });

  it("the filter and org-scoping still block an audience member (defense in depth)", async () => {
    const filter = (_e: unknown, req: FastifyRequest) => req.headers["x-perm"] !== "none";
    const { app, port } = await buildApp({ filter });
    apps.push(app);
    const a = await open(port, app, as("a", { "x-org": "org-1" }));
    const noPerm = await open(port, app, as("b", { "x-perm": "none" }));
    const otherOrg = await open(port, app, as("c", { "x-org": "org-2" }));

    await app.events.publish(
      "comms.message.sent",
      { participantIds: ["a", "b", "c"] },
      { organizationId: "org-1" },
    );
    await drain(app, [a, otherOrg]);

    expect(a.body()).toContain("comms.message.sent");
    expect(noPerm.body()).not.toContain("comms.message.sent");
    expect(otherOrg.body()).not.toContain("comms.message.sent");
  });

  it("null audience falls back to broadcast through the filter", async () => {
    const filter = (_e: unknown, req: FastifyRequest) => req.headers["x-user"] !== "c";
    const { app, port } = await buildApp({ filter });
    apps.push(app);
    const a = await open(port, app, as("a"));
    const b = await open(port, app, as("b"));
    const c = await open(port, app, as("c"));
    const anon = await open(port, app, {});

    await app.events.publish("incident.created", { id: "i1" });
    await app.events.publish("comms.message.sent", { participantIds: ["a"] });
    await waitFor(() => [a, b, anon].every((x) => x.body().includes("incident.created")), {
      label: "broadcast on a, b and the key-less connection",
    });

    expect(c.body()).not.toContain("incident.created");
    // A key-less connection receives broadcasts only, never keyed events.
    expect(anon.body()).not.toContain("comms.message.sent");
    expect(app.sseStats()).toEqual({ connections: 4, keys: 3 });
  });

  it("delivers to every tab/device of the same user, once each", async () => {
    const { app, port } = await buildApp();
    apps.push(app);
    const tab1 = await open(port, app, as("a"));
    const tab2 = await open(port, app, as("a"));
    const other = await open(port, app, as("b"));

    // Duplicate keys in the audience must not double-write a connection.
    await app.events.publish("comms.message.sent", { participantIds: ["a", "a"] });
    await waitFor(() => [tab1, tab2].every((t) => t.body().includes("comms.message.sent")), {
      label: "both tabs of user a",
    });
    await drain(app, [tab1, tab2, other]);

    for (const tab of [tab1, tab2]) {
      expect(tab.body().split("event: comms.message.sent").length - 1).toBe(1);
    }
    expect(other.body()).not.toContain("comms.message.sent");
    expect(app.sseStats()).toEqual({ connections: 3, keys: 2 });
  });

  it("removes every connection and key on disconnect — no leak across many cycles", async () => {
    const { app, port } = await buildApp();
    apps.push(app);

    for (let round = 0; round < 20; round++) {
      const batch = await Promise.all(
        Array.from({ length: 10 }, (_, i) => connect(port, as(`u${i % 4}`))),
      );
      await waitFor(() => app.sseStats().connections === 10, { label: `round ${round} open` });
      for (const c of batch) c.close();
      await waitFor(() => app.sseStats().connections === 0 && app.sseStats().keys === 0, {
        label: `round ${round} cleaned up`,
      });
    }

    // The shared subscription survives the churn.
    const a = await open(port, app, as("u1"));
    await app.events.publish("comms.message.sent", { participantIds: ["u1"] });
    await waitFor(() => a.body().includes("comms.message.sent"), { label: "delivery after churn" });
  });

  it("a throwing audience resolver drops that event (fail-closed) without breaking the stream", async () => {
    const { app, port } = await buildApp({
      audience: (event) => {
        if (event.type === "comms.bad") throw new Error("boom");
        return commsAudience(event);
      },
    });
    apps.push(app);
    const a = await open(port, app, as("a"));

    await app.events.publish("comms.bad", { participantIds: ["a"] });
    await app.events.publish("comms.message.sent", { participantIds: ["a"] });
    await waitFor(() => a.body().includes("comms.message.sent"), { label: "next event" });
    expect(a.body()).not.toContain("comms.bad");
  });

  it("works across replicas over the Redis transport — each resolves against its own connections", async () => {
    const hub = createHub();
    const r1 = await buildApp({}, new RedisEventTransport(fakeRedis(hub), { logger: silent }));
    const r2 = await buildApp({}, new RedisEventTransport(fakeRedis(hub), { logger: silent }));
    apps.push(r1.app, r2.app);
    const aOn1 = await open(r1.port, r1.app, as("a"));
    const bOn2 = await open(r2.port, r2.app, as("b"));
    const cOn2 = await open(r2.port, r2.app, as("c"));

    await r1.app.events.publish("comms.message.sent", { participantIds: ["a", "b"] });
    await waitFor(() => [aOn1, bOn2].every((x) => x.body().includes("comms.message.sent")), {
      label: "a on replica 1 and b on replica 2",
    });
    await drain(r2.app, [bOn2, cOn2]);
    expect(cOn2.body()).not.toContain("comms.message.sent");
  });
});

// ---------------------------------------------------------------------------
// Minimal in-process Redis pub/sub hub (PSUBSCRIBE / PUBLISH only).
// ---------------------------------------------------------------------------

const silent = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

type Hub = Set<{ pattern: string; deliver: (p: string, ch: string, msg: string) => void }>;

function createHub(): Hub {
  return new Set();
}

function fakeRedis(hub: Hub): RedisLike {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const client: RedisLike = {
    publish: async (channel, message) => {
      for (const sub of hub) {
        const prefix = sub.pattern.endsWith("*") ? sub.pattern.slice(0, -1) : sub.pattern;
        if (sub.pattern === channel || (sub.pattern.endsWith("*") && channel.startsWith(prefix))) {
          sub.deliver(sub.pattern, channel, message);
        }
      }
      return 1;
    },
    subscribe: async (...channels) => {
      for (const pattern of channels) {
        hub.add({
          pattern,
          deliver: (_p, ch, msg) => {
            for (const l of listeners.get("message") ?? []) l(ch, msg);
          },
        });
      }
    },
    psubscribe: async (...patterns) => {
      for (const pattern of patterns) {
        hub.add({
          pattern,
          deliver: (p, ch, msg) => {
            for (const l of listeners.get("pmessage") ?? []) l(p, ch, msg);
          },
        });
      }
    },
    on: (event, handler) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return client;
    },
    duplicate: () => fakeRedis(hub),
    quit: async () => "OK",
  };
  return client;
}
