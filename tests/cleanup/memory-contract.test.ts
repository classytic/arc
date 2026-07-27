/**
 * Pins BOTH halves of the durability contract at once:
 *
 *   - `MemoryCleanupRunStore` (arc's shipped reference implementation) really
 *     does provide the atomic semantics the service depends on, and
 *   - `runCleanupRunStoreContract` (the suite hosts run against their own DB
 *     adapter) actually exercises them.
 *
 * A host writing a Mongo/Postgres `CleanupRunStore` runs the same suite against
 * its adapter; passing it IS the contract.
 */
import { MemoryCleanupRunStore } from "../../src/cleanup/index.js";
import { runCleanupRunStoreContract } from "../../src/testing/cleanupStoreContract.js";

runCleanupRunStoreContract("MemoryCleanupRunStore", async () => ({
  store: new MemoryCleanupRunStore(),
}));
