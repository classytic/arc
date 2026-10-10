/**
 * Durable money events: a fixed id per occurrence, the facade refuses a durable type whatever
 * `failOpen` says, `withRetry` never acknowledges an exhausted event nothing recorded, and the
 * repository outbox refuses a second payload under one id.
 */

import { NonDurablePublishError } from "@classytic/primitives/durable-events";
import { OutboxConflictError } from "@classytic/primitives/outbox";
import type { RepositoryLike } from "@classytic/repo-core/adapter";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createEventRegistry, defineEvent } from "../../src/events/defineEvent.js";
import type { DomainEvent } from "../../src/events/EventTransport.js";
import { eventPlugin } from "../../src/events/eventPlugin.js";
import { repositoryAsOutboxStore } from "../../src/events/repository-outbox-adapter.js";
import { withRetry } from "../../src/events/retry.js";

interface GoodsIssued {
  fulfillmentId: string;
  orderNumber: string;
  costMinor: number;
}

const GoodsIssued = defineEvent<GoodsIssued>({
  name: "order:goods.issued",
  durability: "durable",
  occurrence: (p) => p.fulfillmentId,
});

const silentLogger = { warn: () => {}, error: () => {} };

describe("defineEvent — durable definitions", () => {
  it("stamps a fixed id per occurrence, used as the idempotency key", () => {
    const a = GoodsIssued.create({
      fulfillmentId: "ful_1",
      orderNumber: "SO-1",
      costMinor: 125_000,
    });
    const again = GoodsIssued.create({
      fulfillmentId: "ful_1",
      orderNumber: "SO-1",
      costMinor: 125_000,
    });
    const second = GoodsIssued.create({
      fulfillmentId: "ful_2",
      orderNumber: "SO-1",
      costMinor: 40_000,
    });
    expect(a.meta.id).toBe("order:goods.issued:v1:ful_1");
    expect(again.meta.id).toBe(a.meta.id);
    expect(a.meta.idempotencyKey).toBe(a.meta.id);
    expect(second.meta.id).not.toBe(a.meta.id);
    expect(GoodsIssued.durability).toBe("durable");
  });

  it("refuses a caller id that contradicts the occurrence, and a durable type with no occurrence", () => {
    expect(() =>
      GoodsIssued.create(
        { fulfillmentId: "ful_1", orderNumber: "SO-1", costMinor: 1 },
        { id: "random-uuid" },
      ),
    ).toThrow(/contradicts/);
    expect(() =>
      Reflect.apply(defineEvent, undefined, [{ name: "x:y", durability: "durable" }]),
    ).toThrow(/occurrence/);
  });

  it("an empty occurrence throws instead of minting a shared id", () => {
    expect(() =>
      GoodsIssued.create({ fulfillmentId: "", orderNumber: "SO-1", costMinor: 1 }),
    ).toThrow(/occurrence/);
  });

  it("the registry catalogue reports durability", () => {
    const registry = createEventRegistry();
    registry.register(GoodsIssued);
    expect(registry.catalog()[0]?.durability).toBe("durable");
  });
});

describe("fastify.events — per-type fail-closed", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close().catch(() => {});
    app = undefined;
  });

  async function boot(): Promise<{ seen: string[]; app: FastifyInstance }> {
    const registry = createEventRegistry();
    registry.register(GoodsIssued);
    registry.register(defineEvent({ name: "order:viewed", durability: "ephemeral" }));
    const instance = Fastify({ logger: false });
    await instance.register(eventPlugin, { registry, failOpen: true });
    await instance.ready();
    const seen: string[] = [];
    await instance.events.subscribe("order:*", async (e) => {
      seen.push(e.type);
    });
    app = instance;
    return { seen, app: instance };
  }

  it("refuses a durable type even with failOpen: true, and delivers nothing", async () => {
    const { seen, app: instance } = await boot();
    await expect(
      instance.events.publish("order:goods.issued", {
        fulfillmentId: "ful_1",
        orderNumber: "SO-1",
        costMinor: 125_000,
      }),
    ).rejects.toBeInstanceOf(NonDurablePublishError);
    expect(seen).toEqual([]);
  });

  it("an ephemeral type still publishes through the facade", async () => {
    const { seen, app: instance } = await boot();
    await instance.events.publish("order:viewed", {});
    expect(seen).toEqual(["order:viewed"]);
  });
});

describe("withRetry — exhaustion without a durable sink", () => {
  const failing = async (): Promise<void> => {
    throw new Error("ledger down");
  };
  const evt: DomainEvent = {
    type: "order:goods.issued",
    payload: {},
    meta: { id: "e1", timestamp: new Date() },
  };

  it("rethrows, so the outbox relay keeps the delivery owed", async () => {
    const dead: string[] = [];
    const handler = withRetry(failing, {
      maxRetries: 1,
      backoffMs: 1,
      name: "ledger-cogs",
      logger: silentLogger,
      onDead: async (e) => {
        dead.push(e.meta.id);
      },
    });
    await expect(handler(evt)).rejects.toThrow(/ledger-cogs.*no dead-letter sink/s);
    expect(dead).toEqual(["e1"]);
  });

  it("acknowledges only when told the loss is acceptable, or a sink recorded it", async () => {
    await expect(
      withRetry(failing, { maxRetries: 0, logger: silentLogger, dlqFailureMode: "log-and-drop" })(
        evt,
      ),
    ).resolves.toBeUndefined();
    const recorded: string[] = [];
    await expect(
      withRetry(failing, {
        maxRetries: 0,
        logger: silentLogger,
        deadLetter: async (e) => {
          recorded.push(e.meta.id);
        },
      })(evt),
    ).resolves.toBeUndefined();
    expect(recorded).toEqual(["e1"]);
  });
});

describe("repositoryAsOutboxStore — one occurrence per id", () => {
  const dupError = (): Error => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

  function fakeRepository(
    create: (doc: unknown) => Promise<unknown>,
    existing: Record<string, unknown> | null,
  ): RepositoryLike {
    return {
      create,
      getOne: async () => existing,
      getById: async () => null,
      update: async () => null,
      delete: async () => null,
      getAll: async () => ({ data: [], total: 0, page: 1, limit: 0, pages: 0 }),
      deleteMany: async () => ({ deletedCount: 0 }),
      findOneAndUpdate: async () => null,
    };
  }

  function repoWith(
    existing: Record<string, unknown> | null,
    created: Record<string, unknown>[] = [],
  ) {
    return repositoryAsOutboxStore(
      fakeRepository(async (doc) => {
        if (typeof doc === "object" && doc !== null) created.push({ ...doc });
        if (existing) throw dupError();
        return doc;
      }, existing),
    );
  }

  const issued = GoodsIssued.create({
    fulfillmentId: "ful_1",
    orderNumber: "SO-1",
    costMinor: 125_000,
  });

  it("a duplicate with the same payload is an idempotent success", async () => {
    const store = repoWith({ _id: issued.meta.id, type: issued.type, event: issued });
    await expect(store.save(issued)).resolves.toBeUndefined();
  });

  it("a duplicate with a different payload throws OutboxConflictError", async () => {
    const store = repoWith({ _id: issued.meta.id, type: issued.type, event: issued });
    const other = { ...issued, payload: { ...issued.payload, costMinor: 99_000 } };
    await expect(store.save(other)).rejects.toBeInstanceOf(OutboxConflictError);
  });

  it("a duplicate whose row cannot be read back rethrows instead of reporting success", async () => {
    const repository = fakeRepository(async () => {
      throw dupError();
    }, null);
    await expect(repositoryAsOutboxStore(repository).save(issued)).rejects.toThrow(/duplicate key/);
  });

  it("stores the dedupe key scoped by event type", async () => {
    const created: Record<string, unknown>[] = [];
    await repoWith(null, created).save(issued, { dedupeKey: "pay_1" });
    expect(created[0]?.dedupeKey).toBe("order:goods.issued:pay_1");
  });
});
