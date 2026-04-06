import { describe, expect, it } from "vitest";
import { guard } from "../../src/pipeline/guard.js";

describe("guard()", () => {
  it("creates a named guard with _type 'guard'", () => {
    const g = guard("auth-check", async () => true);
    expect(g._type).toBe("guard");
    expect(g.name).toBe("auth-check");
  });

  it("passes context to the handler", async () => {
    const ctx = { user: { id: "1" }, resource: "posts", operation: "create" } as never;
    const g = guard("check", async (c) => {
      expect(c).toBe(ctx);
      return true;
    });
    const result = await g.handler(ctx);
    expect(result).toBe(true);
  });

  it("supports operation filter", () => {
    const g = guard("only-create", async () => true, { operations: ["create", "update"] });
    expect(g.operations).toEqual(["create", "update"]);
  });

  it("defaults operations to undefined (all operations)", () => {
    const g = guard("all-ops", async () => true);
    expect(g.operations).toBeUndefined();
  });

  it("returns false from handler to deny", async () => {
    const g = guard("deny", async () => false);
    const result = await g.handler({} as never);
    expect(result).toBe(false);
  });

  it("handler can throw to deny with custom error", async () => {
    const g = guard("throw-guard", async () => {
      throw new Error("Forbidden");
    });
    await expect(g.handler({} as never)).rejects.toThrow("Forbidden");
  });
});
