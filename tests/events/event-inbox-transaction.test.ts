import { createIdempotencyModel, createIdempotencyStore } from "@classytic/mongokit/idempotency";
import type { IdempotencyClaimStore } from "@classytic/repo-core/idempotency";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { type Connection } from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvent } from "../../src/events/EventTransport.js";
import { EVENT_INBOX_OPERATION, withInbox } from "../../src/events/inbox.js";

describe("transactional inbox with the Mongo kit claim store", () => {
  let database: MongoMemoryReplSet;
  let connection: Connection;

  beforeAll(async () => {
    database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    connection = await mongoose.createConnection(database.getUri()).asPromise();
  });

  afterAll(async () => {
    await connection?.close();
    await database?.stop();
  });

  it("rolls back effect and completion together, retries the transaction and replays the committed result", async () => {
    const claimsModel = createIdempotencyModel(connection);
    const store: IdempotencyClaimStore = createIdempotencyStore(claimsModel);
    const ledger = connection.model(
      "InboxLedger",
      new mongoose.Schema({ _id: String, amount: Number }),
    );
    await Promise.all([claimsModel.init(), ledger.init()]);
    let failCompletion = true;
    const swap = store.swap.bind(store);
    store.swap = async (identity, token, next, options) => {
      const changed = await swap(identity, token, next, options);
      if (failCompletion && next.state === "succeeded") throw new Error("completion write failed");
      return changed;
    };
    let injectTransactionRetry = false;
    let handlerExecutions = 0;
    const subscriber = withInbox(
      "ledger",
      async (event, context) => {
        handlerExecutions++;
        await ledger.create([{ _id: event.meta.id, amount: 125 }], {
          session: context.session as mongoose.ClientSession,
        });
      },
      {
        store,
        transaction: async (work) => {
          const session = await connection.startSession();
          try {
            return await session.withTransaction(async () => {
              const value = await work(session);
              if (injectTransactionRetry) {
                injectTransactionRetry = false;
                throw new mongoose.mongo.MongoServerError({
                  message: "retry transaction",
                  errorLabels: ["TransientTransactionError"],
                });
              }
              return value;
            });
          } finally {
            await session.endSession();
          }
        },
      },
    );
    const event = createEvent("ledger:post", {}, { id: "ledger-1" });
    const identity = { operation: EVENT_INBOX_OPERATION, key: "ledger:ledger-1" };
    await expect(subscriber(event)).rejects.toThrow("completion write failed");
    expect(await ledger.countDocuments()).toBe(0);
    expect(await store.get(identity)).toBeNull();

    failCompletion = false;
    injectTransactionRetry = true;
    await subscriber(event);
    expect(handlerExecutions).toBe(3); // failed completion, aborted transaction, committed retry
    expect(await ledger.countDocuments()).toBe(1);
    expect((await store.get(identity))?.state).toBe("succeeded");
    await subscriber(event);
    expect(handlerExecutions).toBe(3);
    expect(await ledger.countDocuments()).toBe(1);
  });
});
