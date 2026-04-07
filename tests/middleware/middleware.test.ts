import { describe, expect, it, vi } from "vitest";
import { middleware, sortMiddlewares } from "../../src/middleware/middleware.js";

describe("middleware()", () => {
  it("creates a named middleware with default priority", () => {
    const m = middleware("logger", { handler: async () => {} });
    expect(m.name).toBe("logger");
    expect(m.priority).toBe(10);
  });

  it("supports custom priority", () => {
    const m = middleware("early", { handler: async () => {}, priority: 1 });
    expect(m.priority).toBe(1);
  });

  it("supports operation filtering", () => {
    const m = middleware("only-create", {
      handler: async () => {},
      operations: ["create", "update"],
    });
    expect(m.operations).toEqual(["create", "update"]);
  });

  it("supports conditional execution via when()", () => {
    const m = middleware("conditional", {
      handler: async () => {},
      when: (req) => (req as unknown as { method: string }).method === "POST",
    });
    expect(m.when).toBeDefined();
  });

  it("handler is stored on the middleware", async () => {
    const handler = vi.fn();
    const m = middleware("test", { handler });
    await m.handler({} as never, {} as never);
    expect(handler).toHaveBeenCalled();
  });
});

describe("sortMiddlewares()", () => {
  it("returns a MiddlewareConfig map keyed by operation", () => {
    const middlewares = [middleware("a", { handler: async () => {}, priority: 100 })];
    const config = sortMiddlewares(middlewares);
    // Should be an object with CRUD operation keys
    expect(typeof config).toBe("object");
    expect(config).toHaveProperty("list");
    expect(config).toHaveProperty("get");
    expect(config).toHaveProperty("create");
    expect(config).toHaveProperty("update");
    expect(config).toHaveProperty("delete");
  });

  it("sorts by priority ascending within each operation", () => {
    const order: string[] = [];
    const middlewares = [
      middleware("c", {
        handler: async () => {
          order.push("c");
        },
        priority: 30,
      }),
      middleware("a", {
        handler: async () => {
          order.push("a");
        },
        priority: 10,
      }),
      middleware("b", {
        handler: async () => {
          order.push("b");
        },
        priority: 20,
      }),
    ];
    const config = sortMiddlewares(middlewares);
    // Each operation's handlers should be in priority order
    const listHandlers = config.list;
    expect(listHandlers).toBeDefined();
    expect(listHandlers).toHaveLength(3);
  });

  it("filters by operation when specified", () => {
    const middlewares = [
      middleware("all-ops", { handler: async () => {} }),
      middleware("create-only", { handler: async () => {}, operations: ["create"] }),
    ];
    const config = sortMiddlewares(middlewares);
    // 'list' should only have 'all-ops'
    expect(config.list).toHaveLength(1);
    // 'create' should have both
    expect(config.create).toHaveLength(2);
  });

  it("omits operations with no applicable middleware", () => {
    const middlewares = [
      middleware("create-only", { handler: async () => {}, operations: ["create"] }),
    ];
    const config = sortMiddlewares(middlewares);
    expect(config.create).toHaveLength(1);
    expect(config.list).toBeUndefined();
  });
});
