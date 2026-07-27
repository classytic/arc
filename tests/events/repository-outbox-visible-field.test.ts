/**
 * `repositoryAsOutboxStore({ visibleAtField })` — adopting the adapter on an
 * EXISTING outbox table.
 *
 * A host that already runs an outbox keeps its own column name and claim index
 * (be-prod uses `nextVisibleAt` with `{status, nextVisibleAt, createdAt}`).
 * Without this option, adopting the shared adapter would mean renaming a
 * column and rebuilding an index on the table that guarantees delivery — the
 * single thing that made standardizing on it unattractive.
 *
 * Two things must hold, and both are load-bearing:
 *   1. the configured column is what actually gets written, and
 *   2. the claimable filter reads the SAME column — a mismatch would make
 *      every row permanently invisible (silent, total delivery stoppage).
 *
 * The full contract suite runs against the configured store, so the option
 * cannot quietly break any of the six `OutboxStore` invariants either.
 */
import { batchOperationsPlugin, methodRegistryPlugin, Repository } from "@classytic/mongokit";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent } from "../../src/events/EventTransport.js";
import { repositoryAsOutboxStore } from "../../src/events/repository-outbox-adapter.js";
import { runOutboxStoreContract } from "../../src/testing/outboxStoreContract.js";

const VISIBLE_AT_FIELD = "nextVisibleAt";

let mongoServer: MongoMemoryServer;
let OutboxModel: mongoose.Model<Record<string, unknown>>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  OutboxModel = mongoose.model<Record<string, unknown>>(
    "VisibleFieldOutbox",
    new Schema({}, { strict: false, timestamps: false, _id: false }),
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const makeStore = () =>
  repositoryAsOutboxStore(
    new Repository(OutboxModel, [methodRegistryPlugin(), batchOperationsPlugin()]),
    { visibleAtField: VISIBLE_AT_FIELD },
  );

const event = (id: string): DomainEvent =>
  ({ type: "test.event", payload: {}, meta: { id } }) as unknown as DomainEvent;

describe("repositoryAsOutboxStore — configurable visibleAtField", () => {
  it("writes the CONFIGURED column on save, not the default", async () => {
    await OutboxModel.deleteMany({});
    await makeStore().save(event("evt-save"));

    const row = await OutboxModel.findOne({ "event.meta.id": "evt-save" }).lean();
    expect(row?.[VISIBLE_AT_FIELD]).toBeInstanceOf(Date);
    // The default column must be absent — writing both would leave the host's
    // index covering a column the adapter no longer filters on.
    expect(row?.visibleAt).toBeUndefined();
  });

  it("claims rows through the CONFIGURED column (filter and writer agree)", async () => {
    await OutboxModel.deleteMany({});
    const store = makeStore();
    await store.save(event("evt-claim"));

    // If the claimable filter read `visibleAt` while save wrote
    // `nextVisibleAt`, this returns nothing — the silent-stoppage failure.
    const claimed = await store.claimPending?.({ consumerId: "c1", limit: 10 });
    expect(claimed?.length).toBe(1);
  });

  it("schedules a retry on the CONFIGURED column so the row is not re-claimable", async () => {
    await OutboxModel.deleteMany({});
    const store = makeStore();
    await store.save(event("evt-retry"));
    await store.claimPending?.({ consumerId: "c1", limit: 1, leaseMs: 60_000 });

    await store.fail?.(
      "evt-retry",
      { message: "boom" },
      {
        consumerId: "c1",
        retryAt: new Date(Date.now() + 60_000),
      },
    );

    const row = await OutboxModel.findOne({ "event.meta.id": "evt-retry" }).lean();
    expect((row?.[VISIBLE_AT_FIELD] as Date).getTime()).toBeGreaterThan(Date.now());
    // And the deferral must actually take effect through the same column.
    expect(await store.claimPending?.({ consumerId: "c2", limit: 10 })).toEqual([]);
  });
});

// The option must not weaken any OutboxStore invariant.
runOutboxStoreContract(
  `repositoryAsOutboxStore({ visibleAtField: '${VISIBLE_AT_FIELD}' })`,
  async () => ({
    store: makeStore(),
    reset: async () => {
      await OutboxModel.deleteMany({});
    },
  }),
);
