import { describe, expect, it, vi } from "vitest";
import { middleware, sortMiddlewares } from "../../src/middleware/middleware.js";

describe("middleware()", () => {
  it("creates a named middleware with default priority", () => {
    const m = middleware("logger", async () => {});
    expect(m.name).toBe("logger");
    expect(m.priority).toBe(100);
  });

  it("supports custom priority", () => {
    const m = middleware("early", async () => {}, { priority: 10 });
    expect(m.priority).toBe(10);
  });

  it("supports operation filtering", () => {
    const m = middleware("only-create", async () => {}, {
      operations: ["create", "update"],
    });
    expect(m.operations).toEqual(["create", "update"]);
  });

  it("supports conditional execution via when()", () => {
    const m = middleware("conditional", async () => {}, {
      when: (req) => req.method === "POST",
    });
    expect(m.when).toBeDefined();
    expect(m.when!({ method: "POST" } as never)).toBe(true);
    expect(m.when!({ method: "GET" } as never)).toBe(false);
  });

  it("handler receives request context", async () => {
    const handler = vi.fn();
    const m = middleware("test", handler);
    const ctx = { method: "POST" };
    await m.handler(ctx as never);
    expect(handler).toHaveBeenCalledWith(ctx);
  });
});

describe("sortMiddlewares()", () => {
  it("sorts by priority ascending", () => {
    const middlewares = [
      middleware("c", async () => {}, { priority: 300 }),
      middleware("a", async () => {}, { priority: 100 }),
      middleware("b", async () => {}, { priority: 200 }),
    ];
    const sorted = sortMiddlewares(middlewares);
    // sortMiddlewares returns a config map or sorted array
    // Check that they're ordered by priority
    const names = sorted.map((m: { name: string }) => m.name);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("preserves insertion order for same priority", () => {
    const middlewares = [
      middleware("first", async () => {}, { priority: 100 }),
      middleware("second", async () => {}, { priority: 100 }),
    ];
    const sorted = sortMiddlewares(middlewares);
    const names = sorted.map((m: { name: string }) => m.name);
    expect(names).toEqual(["first", "second"]);
  });
});
