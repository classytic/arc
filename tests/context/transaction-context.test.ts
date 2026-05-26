import { describe, expect, it } from "vitest";
import { transactionContext } from "../../src/context/transactionContext.js";

describe("transactionContext", () => {
  it("returns undefined outside a run scope", () => {
    expect(transactionContext.get()).toBeUndefined();
  });

  it("returns the session inside run()", async () => {
    const fakeSession = { id: "session-1" };
    await transactionContext.run(fakeSession, async () => {
      expect(transactionContext.get()).toBe(fakeSession);
    });
  });

  it("is undefined again after run() resolves", async () => {
    await transactionContext.run({ id: "s" }, async () => {});
    expect(transactionContext.get()).toBeUndefined();
  });

  it("nests correctly — inner scope wins", async () => {
    const outer = { id: "outer" };
    const inner = { id: "inner" };
    await transactionContext.run(outer, async () => {
      expect(transactionContext.get()).toBe(outer);
      await transactionContext.run(inner, async () => {
        expect(transactionContext.get()).toBe(inner);
      });
      expect(transactionContext.get()).toBe(outer);
    });
  });

  it("accepts any session type (DB-agnostic)", async () => {
    const mongooseSession = { id: "mongo", startTransaction: () => {} };
    const prismaClient = { id: "prisma", $transaction: async () => {} };

    await transactionContext.run(mongooseSession, async () => {
      expect(transactionContext.get()).toBe(mongooseSession);
    });
    await transactionContext.run(prismaClient, async () => {
      expect(transactionContext.get()).toBe(prismaClient);
    });
  });
});
