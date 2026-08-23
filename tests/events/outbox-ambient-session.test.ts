/**
 * `createOutboxModule` joins the caller's transaction by DEFAULT.
 *
 * The capability was already there: `EventOutbox.store()` auto-injects a
 * session from `sessionProvider` (an explicit `options.session` still wins).
 * What was missing is the DEFAULT — every host had to remember to pass
 * `sessionProvider: () => transactionContext.get()`, while `auditPlugin` has
 * defaulted the same thing since it shipped.
 *
 * A host that forgot got no error. It got an event row written outside the
 * transaction, surviving a rollback and reporting something that never
 * happened — the exact guarantee an outbox exists to provide, inverted. Six
 * consumers had to be wired by hand in each of the two ERP hosts this module's
 * docblock describes; "remember to pass it" is the same design problem the
 * module was created to end.
 *
 * These assert at the STORE's interface — what session the write actually
 * carried — not on `EventOutbox` internals, so they survive a refactor of how
 * the injection is plumbed.
 */

import { describe, expect, it, vi } from "vitest";
import { transactionContext } from "../../src/context/transactionContext.js";
import { EventOutbox } from "../../src/events/outbox.js";

const SESSION = { id: "tx-session" } as const;

/** A store that records the write options it was handed. */
function recordingStore() {
  const saved: Array<{ session?: unknown }> = [];
  return {
    saved,
    store: {
      async save(_event: unknown, options?: { session?: unknown }) {
        saved.push({ session: options?.session });
      },
      async claimPending() {
        return [];
      },
      async acknowledge() {},
      async fail() {},
    } as never,
  };
}

function anEvent(id = "e1") {
  return { type: "order.created", payload: {}, meta: { id } } as never;
}

/** The default wiring `createOutboxModule` now installs. */
const ambient = () => transactionContext.get();

describe("outbox joins the ambient transaction", () => {
  it("store() picks up the session published by a transactional write", async () => {
    const { store, saved } = recordingStore();
    const outbox = new EventOutbox({ store, sessionProvider: ambient });

    await transactionContext.run(SESSION, async () => {
      await outbox.store(anEvent());
    });

    expect(saved[0]?.session).toBe(SESSION);
  });

  it("outside a transaction the write stays session-less", async () => {
    // The inverse control: injecting unconditionally would hand the store a
    // bogus session and claim an atomicity that does not exist.
    const { store, saved } = recordingStore();
    const outbox = new EventOutbox({ store, sessionProvider: ambient });

    await outbox.store(anEvent());

    expect(saved[0]?.session).toBeUndefined();
  });

  it("an EXPLICIT session still wins over the ambient one", async () => {
    // Documented precedence. A caller that names a session has a reason —
    // typically a write that must NOT join the request's transaction.
    const explicit = { id: "explicit" };
    const { store, saved } = recordingStore();
    const outbox = new EventOutbox({ store, sessionProvider: ambient });

    await transactionContext.run(SESSION, async () => {
      await outbox.store(anEvent(), { session: explicit });
    });

    expect(saved[0]?.session).toBe(explicit);
  });

  it("no provider means no injection — the opt-out path", async () => {
    // `sessionProvider: false` on the module resolves to constructing without
    // one; an outbox on its own connection must not be dragged into a
    // transaction it cannot see.
    const { store, saved } = recordingStore();
    const outbox = new EventOutbox({ store });

    await transactionContext.run(SESSION, async () => {
      await outbox.store(anEvent());
    });

    expect(saved[0]?.session).toBeUndefined();
  });

  it("the provider is consulted PER WRITE, not captured once", async () => {
    // Two writes in different scopes must land in different transactions —
    // a provider read once at construction would put both in the first.
    const { store, saved } = recordingStore();
    const outbox = new EventOutbox({ store, sessionProvider: ambient });
    const second = { id: "tx-2" };

    await transactionContext.run(SESSION, () => outbox.store(anEvent("a")));
    await transactionContext.run(second, () => outbox.store(anEvent("b")));

    expect(saved.map((s) => s.session)).toEqual([SESSION, second]);
  });
});

describe("createOutboxModule wires the default", () => {
  /** Drive the module's real bootstrap and return the relay it built. */
  async function relayFrom(options: Record<string, unknown>) {
    const { createOutboxModule } = await import("../../src/events/outbox-module.js");
    const mod = createOutboxModule(options as never);
    const fastify = { log: { error() {}, warn() {}, info() {} } } as never;
    return (mod as unknown as { bootstrap: (f: unknown) => { relay: EventOutbox } }).bootstrap(
      fastify,
    ).relay;
  }

  it("a module-built outbox joins the ambient transaction with NO host wiring", async () => {
    // The whole point: the host passes a store and nothing else.
    const { store, saved } = recordingStore();
    const relay = await relayFrom({ store, transport: { async publish() {} } });

    await transactionContext.run(SESSION, () => relay.store(anEvent()));

    expect(saved[0]?.session).toBe(SESSION);
  });

  it("`sessionProvider: false` opts out", async () => {
    const { store, saved } = recordingStore();
    const relay = await relayFrom({
      store,
      transport: { async publish() {} },
      sessionProvider: false,
    });

    await transactionContext.run(SESSION, () => relay.store(anEvent()));

    expect(saved[0]?.session).toBeUndefined();
  });

  it("an explicit provider is honoured over the default", async () => {
    const custom = { id: "custom" };
    const { store, saved } = recordingStore();
    const relay = await relayFrom({
      store,
      transport: { async publish() {} },
      sessionProvider: () => custom,
    });

    await relay.store(anEvent());

    expect(saved[0]?.session).toBe(custom);
  });
});
