import { describe, expect, it } from "vitest";
import { transform } from "../../src/pipeline/transform.js";

describe("transform()", () => {
  it("creates a named transform with _type 'transform'", () => {
    const t = transform("sanitize", async (ctx) => ctx);
    expect(t._type).toBe("transform");
    expect(t.name).toBe("sanitize");
  });

  it("supports operation filter", () => {
    const t = transform("trim", async (ctx) => ctx, { operations: ["create"] });
    expect(t.operations).toEqual(["create"]);
  });

  it("handler can return modified context", async () => {
    const t = transform("add-field", async (ctx) => {
      return { ...ctx, extra: true };
    });
    const result = await t.handler({ data: 1 } as never);
    expect(result).toEqual({ data: 1, extra: true });
  });

  it("handler can mutate context in place", async () => {
    const t = transform("mutate", async (ctx: Record<string, unknown>) => {
      ctx.mutated = true;
      return ctx;
    });
    const ctx = { data: 1 } as never;
    await t.handler(ctx);
    expect((ctx as Record<string, unknown>).mutated).toBe(true);
  });
});
