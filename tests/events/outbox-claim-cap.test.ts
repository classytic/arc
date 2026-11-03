/**
 * A repository that caps one read below the relay's `batchSize` (mongokit's
 * generic page `maxLimit`, 100 by default) must not leave the relay believing
 * a clamped page was "not full". The store learns the cap from the page the
 * repository returned, warns once, and the relay's effective `batchSize`
 * follows it.
 */

import { Repository } from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Connection } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEvent, MemoryEventTransport } from "../../src/events/EventTransport.js";
import { EventOutbox } from "../../src/events/outbox/relay.js";
import { repositoryAsOutboxStore } from "../../src/events/repository-outbox-adapter.js";

describe("outbox claim cap (a repository page maxLimit below batchSize)", () => {
  let server: MongoMemoryServer;
  let connection: Connection;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(server.getUri()).asPromise();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await connection?.close();
    await server?.stop();
  });

  function cappedRepository(name: string, maxLimit: number) {
    const model = connection.model(
      name,
      new mongoose.Schema({ _id: String }, { strict: false, collection: name.toLowerCase() }),
    );
    return new Repository(model, [], { maxLimit });
  }

  it("reports the cap, warns once, and the relay's batchSize follows it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const repository = cappedRepository("CappedOutbox", 100);
    const relay = new EventOutbox({
      repository,
      transport: new MemoryEventTransport(),
      batchSize: 150,
    });
    for (let i = 0; i < 250; i++) {
      await relay.store(createEvent("cap.test", { i }, { id: `cap-${i}` }));
    }

    expect(relay.batchSize).toBe(150);
    const first = await relay.relayBatch();
    expect(first.attempted).toBe(100);
    // "attempted < batchSize" must not read as "backlog empty": the cap is now known.
    expect(relay.batchSize).toBe(100);
    expect(first.attempted).toBe(relay.batchSize);

    const second = await relay.relayBatch();
    expect(second.attempted).toBe(100);
    const third = await relay.relayBatch();
    expect(third.attempted).toBe(50);
    expect(third.attempted).toBeLessThan(relay.batchSize);

    const capWarnings = warn.mock.calls.filter((call) =>
      call.some((part) => typeof part === "string" && part.includes("OUTBOX_CLAIM_CAPPED")),
    );
    expect(capWarnings).toHaveLength(1);
    expect(String(capWarnings[0]?.join(" "))).toContain("asked 150, got 100");
  });

  it("exposes the learnt cap on the store, and none when the repository does not clamp", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const capped = repositoryAsOutboxStore(cappedRepository("CappedStore", 3));
    const open = repositoryAsOutboxStore(cappedRepository("OpenStore", 0));
    for (let i = 0; i < 5; i++) {
      await capped.save(createEvent("cap.test", { i }, { id: `capped-${i}` }));
      await open.save(createEvent("cap.test", { i }, { id: `open-${i}` }));
    }
    expect(capped.claimCap).toBeUndefined();
    expect(await capped.claimPending({ consumerId: "a", limit: 5 })).toHaveLength(3);
    expect(capped.claimCap).toBe(3);

    expect(await open.claimPending({ consumerId: "a", limit: 5 })).toHaveLength(5);
    expect(open.claimCap).toBeUndefined();
  });
});
