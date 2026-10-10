/**
 * Per-handler inbox: a redelivered event re-runs ONLY the handler that failed. Without it the
 * relay's retry re-runs every handler of the event, so a failing notification re-posts the ledger.
 */

import { createMemoryIdempotencyStore } from "@classytic/repo-core/idempotency";
import { describe, expect, it } from "vitest";
import { createEvent, MemoryEventTransport } from "../../src/events/EventTransport.js";
import { withInbox } from "../../src/events/inbox.js";
import { EventOutbox, MemoryOutboxStore } from "../../src/events/outbox.js";

const silent = { warn: () => {}, error: () => {} };

async function setup() {
  const store = new MemoryOutboxStore();
  const transport = new MemoryEventTransport({ onHandlerError: "throw", logger: silent });
  const relay = new EventOutbox({ store, transport, failurePolicy: () => ({}) });
  const inbox = createMemoryIdempotencyStore();
  const runs = { ledger: 0, notify: 0 };
  let notifyFails = true;
  await transport.subscribe(
    "order:goods.issued",
    withInbox(
      "ledger-cogs",
      async () => {
        runs.ledger++;
      },
      { store: inbox },
    ),
  );
  await transport.subscribe(
    "order:goods.issued",
    withInbox(
      "customer-notify",
      async () => {
        runs.notify++;
        if (notifyFails) throw new Error("smtp down");
      },
      { store: inbox },
    ),
  );
  return {
    store,
    relay,
    inbox,
    runs,
    heal: () => {
      notifyFails = false;
    },
  };
}

describe("withInbox — one run per (handler, event id)", () => {
  it("a relay retry re-runs only the handler that failed", async () => {
    const { store, relay, runs, heal } = await setup();
    await store.save(createEvent("order:goods.issued", { costMinor: 125_000 }, { id: "gi:ful_1" }));

    const first = await relay.relayBatch();
    expect(first.publishFailed).toBe(1);
    expect(runs).toEqual({ ledger: 1, notify: 1 });

    heal();
    const second = await relay.relayBatch();
    expect(second.relayed).toBe(1);
    expect(runs).toEqual({ ledger: 1, notify: 2 });
    expect(await store.countByStatus("pending")).toBe(0);
  });

  it("records the claim under the handler's own name", async () => {
    const { store, relay, inbox } = await setup();
    await store.save(createEvent("order:goods.issued", { costMinor: 1 }, { id: "gi:ful_2" }));
    await relay.relayBatch();
    const byKey = Object.fromEntries(inbox.claims().map((c) => [c.identity.key, c.state]));
    expect(byKey["ledger-cogs:gi:ful_2"]).toBe("succeeded");
    // A transient failure releases the claim, so the retry executes afresh.
    expect(byKey["customer-notify:gi:ful_2"]).toBeUndefined();
  });

  it("a claim another worker holds is a FAILED delivery, never a silent skip", async () => {
    const inbox = createMemoryIdempotencyStore();
    let release: () => void = () => {};
    const slow = withInbox(
      "ledger-cogs",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      { store: inbox },
    );
    const event = createEvent("order:goods.issued", {}, { id: "gi:ful_3" });
    const running = slow(event);
    await new Promise((r) => setTimeout(r, 5));
    await expect(slow(event)).rejects.toThrow(/in flight/);
    release();
    await running;
  });

  it("refuses an empty handler name", () => {
    expect(() => withInbox("", async () => {}, { store: createMemoryIdempotencyStore() })).toThrow(
      /name/,
    );
  });

  it("rolls back a business effect when inbox completion fails in the shared transaction", async () => {
    let committed = 0;
    let failCompletion = true;
    const session = { effect: 0 };
    const store = createMemoryIdempotencyStore();
    const swap = store.swap.bind(store);
    store.swap = async (identity, token, next, options) => {
      expect(options?.session).toBe(session);
      if (failCompletion && next.state === "succeeded") throw new Error("commit unavailable");
      return swap(identity, token, next, options);
    };
    const handler = withInbox(
      "atomic-ledger",
      async (_event, context) => {
        expect(context.session).toBe(session);
        session.effect++;
      },
      {
        store,
        transaction: async (work) => {
          session.effect = committed;
          try {
            const value = await work(session);
            committed = session.effect;
            return value;
          } catch (error) {
            // The fake database discards this transaction's effect and inserted claim.
            const claim = store.claims()[0];
            if (claim) await store.release(claim.identity, claim.leaseToken);
            throw error;
          }
        },
      },
    );
    const event = createEvent("ledger:post", {}, { id: "atomic-1" });
    await expect(handler(event)).rejects.toThrow("commit unavailable");
    expect(committed).toBe(0);
    failCompletion = false;
    await handler(event);
    await handler(event);
    expect(committed).toBe(1);
  });
});
