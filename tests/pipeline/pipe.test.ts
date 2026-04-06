import { describe, expect, it, vi } from "vitest";
import { executePipeline, pipe } from "../../src/pipeline/pipe.js";
import { guard } from "../../src/pipeline/guard.js";
import { transform } from "../../src/pipeline/transform.js";
import { intercept } from "../../src/pipeline/intercept.js";

describe("pipe()", () => {
  it("composes steps into a pipeline config", () => {
    const g = guard("g1", async () => true);
    const t = transform("t1", async (ctx) => ctx);
    const pipeline = pipe(g, t);
    expect(pipeline).toEqual([g, t]);
  });

  it("returns an array of pipeline steps", () => {
    const steps = pipe(
      guard("a", async () => true),
      transform("b", async (ctx) => ctx),
    );
    expect(Array.isArray(steps)).toBe(true);
    expect(steps).toHaveLength(2);
  });
});

describe("executePipeline()", () => {
  it("executes handler when no steps", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const result = await executePipeline([], {} as never, handler, "list");
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true });
  });

  it("runs guards before handler", async () => {
    const order: string[] = [];
    const g = guard("g1", async () => {
      order.push("guard");
      return true;
    });
    const handler = vi.fn().mockImplementation(async () => {
      order.push("handler");
      return { ok: true };
    });

    await executePipeline([g], {} as never, handler, "create");
    expect(order).toEqual(["guard", "handler"]);
  });

  it("stops execution when guard returns false", async () => {
    const g = guard("deny", async () => false);
    const handler = vi.fn();

    await expect(
      executePipeline([g], {} as never, handler, "create"),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs transforms before handler", async () => {
    const order: string[] = [];
    const t = transform("t1", async (ctx) => {
      order.push("transform");
      return ctx;
    });
    const handler = vi.fn().mockImplementation(async () => {
      order.push("handler");
      return {};
    });

    await executePipeline([t], {} as never, handler, "create");
    expect(order).toEqual(["transform", "handler"]);
  });

  it("runs interceptors wrapping handler", async () => {
    const order: string[] = [];
    const i = intercept("i1", async (_ctx, next) => {
      order.push("before-intercept");
      const result = await next();
      order.push("after-intercept");
      return result;
    });
    const handler = vi.fn().mockImplementation(async () => {
      order.push("handler");
      return { data: 1 };
    });

    await executePipeline([i], {} as never, handler, "create");
    expect(order).toEqual(["before-intercept", "handler", "after-intercept"]);
  });

  it("executes in order: guards → transforms → interceptors → handler", async () => {
    const order: string[] = [];
    const g = guard("g", async () => {
      order.push("guard");
      return true;
    });
    const t = transform("t", async (ctx) => {
      order.push("transform");
      return ctx;
    });
    const i = intercept("i", async (_ctx, next) => {
      order.push("intercept");
      return next();
    });
    const handler = vi.fn().mockImplementation(async () => {
      order.push("handler");
      return {};
    });

    await executePipeline([g, t, i], {} as never, handler, "create");
    expect(order).toEqual(["guard", "transform", "intercept", "handler"]);
  });

  it("skips steps filtered by operation", async () => {
    const order: string[] = [];
    const g = guard("only-delete", async () => {
      order.push("guard");
      return true;
    }, { operations: ["delete"] });
    const handler = vi.fn().mockImplementation(async () => {
      order.push("handler");
      return {};
    });

    await executePipeline([g], {} as never, handler, "create");
    // Guard should be skipped because operation is 'create', not 'delete'
    expect(order).toEqual(["handler"]);
  });
});
