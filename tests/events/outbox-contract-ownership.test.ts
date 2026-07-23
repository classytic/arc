/**
 * Lock-in: the outbox CONTRACT is canonically owned by
 * `@classytic/primitives/outbox` (>=0.13). Arc ships the RUNTIME only
 * (`EventOutbox`, `MemoryOutboxStore`, `repositoryAsOutboxStore`,
 * `exponentialBackoff`) and does NOT re-export the contract — hosts and
 * domain packages import it from primitives, exactly like the event
 * contract (`DomainEvent` etc.) since arc 2.12.
 *
 * The load-bearing consequence is CLASS IDENTITY: a domain package that
 * peer-deps only primitives writes `implements OutboxStore` and throws
 * primitives' `OutboxOwnershipError`; arc's relay must catch it via
 * `instanceof`. Under the pre-2.24 duplication arc had its own class with
 * a different identity and silently missed primitives-thrown ownership
 * errors. These assertions prevent anyone from re-inlining the contract.
 */

import { OutboxOwnershipError } from "@classytic/primitives/outbox";
import { describe, expect, it } from "vitest";
import { MemoryOutboxStore } from "../../src/events/outbox.js";

describe("outbox contract ownership — primitives is canonical", () => {
  it("arc runtime throws primitives' OutboxOwnershipError class identity", async () => {
    const store = new MemoryOutboxStore();
    await store.save({
      type: "test.event",
      payload: {},
      meta: { id: "evt-1", timestamp: new Date() },
    });
    await store.claimPending({ consumerId: "worker-A", limit: 1 });

    // A different consumer acking a held lease must throw THE primitives
    // class — this is what a primitives-only domain package catches.
    await expect(store.acknowledge("evt-1", { consumerId: "worker-B" })).rejects.toBeInstanceOf(
      OutboxOwnershipError,
    );
  });

  it("arc's events barrel does NOT re-export the contract (clean break, one owner)", async () => {
    const mod = (await import("../../src/events/index.js")) as Record<string, unknown>;
    // Contract classes live in primitives only.
    expect(mod.OutboxOwnershipError).toBeUndefined();
    expect(mod.InvalidOutboxEventError).toBeUndefined();
    // Runtime stays in arc.
    expect(typeof mod.EventOutbox).toBe("function");
    expect(typeof mod.MemoryOutboxStore).toBe("function");
    expect(typeof mod.exponentialBackoff).toBe("function");
    expect(typeof mod.repositoryAsOutboxStore).toBe("function");
  });

  it("primitives error carries the ownership diagnostics arc's relay reports", () => {
    const err = new OutboxOwnershipError("evt-9", "worker-A", "worker-B");
    expect(err.eventId).toBe("evt-9");
    expect(err.attemptedBy).toBe("worker-A");
    expect(err.currentOwner).toBe("worker-B");
    expect(err.name).toBe("OutboxOwnershipError");
    expect(err.message).toContain("evt-9");
  });
});
