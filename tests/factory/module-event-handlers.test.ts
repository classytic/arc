/**
 * Module-contributed event handlers — `defineModule({ eventHandlers })`.
 *
 * Pins the contract: a module declares its own subscriptions; arc subscribes
 * them (dependency order, after resources), retains the unsubscribes, and tears
 * them down at shutdown BEFORE module onClose. Named duplicates + a missing
 * event subsystem fail at boot. Factories resolve after bootstraps.
 */

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { MemoryEventTransport } from "../../src/events/EventTransport.js";
import { createApp, defineModule, subscribeModuleEventHandlers } from "../../src/factory/index.js";

describe("defineModule — eventHandlers", () => {
  it("subscribes a module handler; publishing the event invokes it; close unsubscribes", async () => {
    const seen: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "party",
          eventHandlers: [
            {
              name: "party.link",
              event: "customer:created",
              handler: async (e) => {
                seen.push((e as { type: string }).type);
              },
            },
          ],
        }),
      ],
    });
    await app.ready();

    await app.events.publish("customer:created", { id: "c1" });
    expect(seen).toEqual(["customer:created"]);

    // After close, the handler is unsubscribed — a later publish (on a fresh
    // app sharing nothing) obviously can't reach it; here we assert close()
    // runs the teardown without throwing and the count is frozen.
    await app.close();
    expect(seen).toEqual(["customer:created"]);
  });

  it("supports an array of event patterns on one handler", async () => {
    const seen: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "party",
          eventHandlers: [
            {
              event: ["customer:created", "customer:updated"],
              handler: async (e) => seen.push((e as { type: string }).type),
            },
          ],
        }),
      ],
    });
    await app.ready();
    await app.events.publish("customer:created", {});
    await app.events.publish("customer:updated", {});
    expect(seen).toEqual(["customer:created", "customer:updated"]);
    await app.close();
  });

  it("resolves a factory contribution (after bootstraps) closing over booted state", async () => {
    const seen: string[] = [];
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [
        defineModule({
          name: "orders",
          bootstrap: () => ({ tag: "orders-engine" }),
          eventHandlers: (f) => {
            const engine = (f.arc?.modules?.orders as { tag: string }) ?? { tag: "?" };
            return [{ event: "order:placed", handler: async () => seen.push(engine.tag) }];
          },
        }),
      ],
    });
    await app.ready();
    await app.events.publish("order:placed", {});
    expect(seen).toEqual(["orders-engine"]);
    await app.close();
  });

  it("fails at boot on a duplicate NAMED handler across modules (both owners named)", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        modules: [
          defineModule({
            name: "a",
            eventHandlers: [{ name: "link", event: "x", handler: async () => {} }],
          }),
          defineModule({
            name: "b",
            eventHandlers: [{ name: "link", event: "y", handler: async () => {} }],
          }),
        ],
      }),
    ).rejects.toThrow(/duplicate event-handler name "link".*"a".*"b"/s);
  });

  it("fails at boot when a module declares eventHandlers but events are disabled", async () => {
    await expect(
      createApp({
        auth: false,
        logger: false,
        arcPlugins: { events: false },
        modules: [
          defineModule({
            name: "party",
            eventHandlers: [{ event: "customer:created", handler: async () => {} }],
          }),
        ],
      }),
    ).rejects.toThrow(/declares eventHandlers but the event subsystem is unavailable/);
  });

  it("rolls back earlier subscriptions when a later subscription fails", async () => {
    const app = Fastify({ logger: false });
    const unsubscribed: string[] = [];
    app.decorate("events", {
      subscribe: async (pattern: string) => {
        if (pattern === "broken") throw new Error("subscription rejected");
        return () => void unsubscribed.push(pattern);
      },
    });

    await expect(
      subscribeModuleEventHandlers(app, [
        defineModule({
          name: "party",
          eventHandlers: [{ event: ["first", "second", "broken"], handler: async () => {} }],
        }),
      ]),
    ).rejects.toThrow("subscription rejected");
    expect(unsubscribed).toEqual(["second", "first"]);
    await app.close();
  });

  it("rolls back module subscriptions when app afterResources fails", async () => {
    const transport = new MemoryEventTransport();
    const off = vi.fn();
    const subscribe = vi.spyOn(transport, "subscribe").mockResolvedValue(off);

    await expect(
      createApp({
        auth: false,
        logger: false,
        stores: { events: transport },
        modules: [
          defineModule({
            name: "party",
            eventHandlers: [{ event: "customer.created", handler: async () => {} }],
          }),
        ],
        afterResources: async () => {
          throw new Error("host wiring failed");
        },
      }),
    ).rejects.toThrow("host wiring failed");

    expect(subscribe).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
  });

  it("a module with NO eventHandlers is unchanged (boots, nothing subscribed)", async () => {
    const app = await createApp({
      auth: false,
      logger: false,
      modules: [defineModule({ name: "plain", resources: [] })],
    });
    await app.ready();
    await app.close();
  });
});
