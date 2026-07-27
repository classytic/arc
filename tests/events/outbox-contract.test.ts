/**
 * Proves BOTH halves of the outbox contract at once:
 *
 *   - `MemoryOutboxStore` (arc's shipped reference store) really does honour
 *     the six MUST invariants in `@classytic/primitives/outbox`, and
 *   - `runOutboxStoreContract` (the suite a host runs against its own DB
 *     store) actually exercises them.
 *
 * A host with a hand-written store — be-prod's `MongoOutboxStore`, or any kit
 * adapter — runs this same suite against its implementation. Passing it IS the
 * contract.
 */
import { MemoryOutboxStore } from "../../src/events/index.js";
import { runOutboxStoreContract } from "../../src/testing/outboxStoreContract.js";

const store = new MemoryOutboxStore();

runOutboxStoreContract("MemoryOutboxStore", async () => ({
  store,
  // Truncate between cases so each invariant is exercised in isolation.
  reset: async () => {
    store.clear();
  },
}));
