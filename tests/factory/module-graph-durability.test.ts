/**
 * The module graph's durability check (WARN mode): a module publishing a durable event depends on
 * a transactional outbox, and every handler of a durable event declares `durability`.
 */
import { MemoryOutboxStore } from "@classytic/primitives/memory-outbox";
import { describe, expect, it } from "vitest";
import { defineEvent } from "../../src/events/defineEvent.js";
import { createOutboxModule } from "../../src/events/outbox-module.js";
import { createApp, defineModule, verifyEventDurability } from "../../src/factory/index.js";

const noop = async () => {};

const GoodsIssued = defineEvent<{ fulfillmentId: string }>({
  name: "order:goods.issued",
  durability: "durable",
  occurrence: (p) => p.fulfillmentId,
});

class TransactionalMemoryStore extends MemoryOutboxStore {
  readonly transactionalSave = true;
}

describe("verifyEventDurability", () => {
  const order = (dependsOn: string[] = []) =>
    defineModule({ name: "order", dependsOn, publishes: [GoodsIssued, "order:viewed"] });

  it("flags a durable publisher with no transactional outbox among its dependencies", () => {
    const issues = verifyEventDurability([order()], {
      outboxModules: new Set(["outbox"]),
      handlers: new Map(),
    });
    expect(issues.map((i) => [i.code, i.module, i.event])).toEqual([
      ["durable-without-outbox", "order", "order:goods.issued"],
    ]);
    expect(
      verifyEventDurability([order(["outbox"])], {
        outboxModules: new Set(["outbox"]),
        handlers: new Map(),
      }),
    ).toEqual([]);
  });

  it("flags a handler of a durable event that declares no durability, wildcards included", () => {
    const handlers = new Map([
      [
        "accounting",
        [
          { label: "accounting.cogs", patterns: ["order:goods.issued"] },
          { label: "accounting.audit", patterns: ["order:*"] },
          {
            label: "accounting.ok",
            patterns: ["order:goods.issued"],
            durability: "retry" as const,
          },
          { label: "accounting.views", patterns: ["order:viewed"] },
        ],
      ],
    ]);
    const issues = verifyEventDurability([order(["outbox"])], {
      outboxModules: new Set(["outbox"]),
      handlers,
    });
    expect(issues.map((i) => [i.code, i.module, i.event])).toEqual([
      ["durable-consumer-undeclared", "accounting", "order:goods.issued"],
      ["durable-consumer-undeclared", "accounting", "order:goods.issued"],
    ]);
    expect(issues[0]?.message).toContain("accounting.cogs");
  });
});

describe("createApp — durability is reported, never blocks (phase 1)", () => {
  async function bootLines(store: MemoryOutboxStore): Promise<string[]> {
    const lines: string[] = [];
    const app = await createApp({
      auth: false,
      logger: { level: "warn", stream: { write: (s: string) => void lines.push(s) } } as never,
      moduleGraph: { events: "strict" },
      modules: [
        createOutboxModule({ store, relayEveryMs: 60_000, runOnStart: false, health: false }),
        defineModule({ name: "order", dependsOn: ["outbox"], publishes: [GoodsIssued] }),
        defineModule({
          name: "accounting",
          eventHandlers: [{ name: "accounting.cogs", event: "order:goods.issued", handler: noop }],
        }),
      ],
    });
    await app.ready();
    await app.close();
    return lines.filter((l) => l.includes("durab"));
  }

  it("boots under strict, and warns about the undeclared consumer and a non-transactional outbox", async () => {
    const lines = await bootLines(new MemoryOutboxStore());
    expect(lines.some((l) => l.includes("durable-without-outbox"))).toBe(true);
    expect(lines.some((l) => l.includes("accounting.cogs"))).toBe(true);
  });

  it("a transactional outbox satisfies the publisher", async () => {
    const lines = await bootLines(new TransactionalMemoryStore());
    expect(lines.some((l) => l.includes("durable-without-outbox"))).toBe(false);
  });
});
