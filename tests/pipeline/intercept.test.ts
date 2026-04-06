import { describe, expect, it } from "vitest";
import { intercept } from "../../src/pipeline/intercept.js";

describe("intercept()", () => {
  it("creates a named interceptor with _type 'interceptor'", () => {
    const i = intercept("logger", async (_ctx, next) => next());
    expect(i._type).toBe("interceptor");
    expect(i.name).toBe("logger");
  });

  it("supports operation filter", () => {
    const i = intercept("cache", async (_ctx, next) => next(), {
      operations: ["list", "get"],
    });
    expect(i.operations).toEqual(["list", "get"]);
  });

  it("can modify the result from next()", async () => {
    const i = intercept("wrap", async (_ctx, next) => {
      const result = await next();
      return { wrapped: true, original: result };
    });

    const mockNext = async () => ({ data: "hello" });
    const result = await i.handler({} as never, mockNext);
    expect(result).toEqual({ wrapped: true, original: { data: "hello" } });
  });

  it("can measure timing around next()", async () => {
    let elapsed = 0;
    const i = intercept("timer", async (_ctx, next) => {
      const start = Date.now();
      const result = await next();
      elapsed = Date.now() - start;
      return result;
    });

    const mockNext = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return {};
    };
    await i.handler({} as never, mockNext);
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it("can short-circuit by not calling next()", async () => {
    const i = intercept("cache-hit", async () => {
      return { cached: true };
    });

    const mockNext = async () => ({ cached: false });
    const result = await i.handler({} as never, mockNext);
    expect(result).toEqual({ cached: true });
  });
});
