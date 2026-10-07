import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createEventRegistry, defineEvent } from "../../src/events/defineEvent.js";

describe("defineEvent({ payload }) — zod in, contract out", () => {
  const OrderPlaced = defineEvent({
    name: "order:placed",
    payload: z.object({
      orderId: z.string(),
      lines: z.array(z.object({ sku: z.string(), qty: z.number().int() })),
      channel: z.enum(["web", "pos"]).optional(),
    }),
  });

  it("the payload TYPE is inferred — no annotation, no cast", () => {
    expectTypeOf(OrderPlaced.create).parameter(0).toEqualTypeOf<{
      orderId: string;
      lines: { sku: string; qty: number }[];
      channel?: "web" | "pos" | undefined;
    }>();
  });

  it("the JSON Schema is generated once, by arc", () => {
    expect(OrderPlaced.schema).toMatchObject({
      type: "object",
      required: ["orderId", "lines"],
      properties: { channel: { enum: ["web", "pos"] } },
    });
  });

  it("the registry validates with zod — nested shapes and enums, not just top-level types", () => {
    const registry = createEventRegistry();
    registry.register(OrderPlaced);
    expect(
      registry.validate("order:placed", { orderId: "o1", lines: [{ sku: "a", qty: 1 }] }),
    ).toEqual({ valid: true });
    const bad = registry.validate("order:placed", {
      orderId: "o1",
      lines: [{ sku: "a", qty: 1.5 }],
      channel: "fax",
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors?.join(" | ")).toMatch(/lines\.0\.qty/);
    expect(bad.errors?.join(" | ")).toMatch(/channel/);
  });

  it("a payload JSON cannot carry fails at DEFINITION, naming the event", () => {
    expect(() => defineEvent({ name: "order:dated", payload: z.object({ at: z.date() }) })).toThrow(
      /event "order:dated".*ISO strings/s,
    );
  });

  it("declaring both payload and schema is refused", () => {
    expect(() =>
      defineEvent({ name: "x", payload: z.object({}), schema: { type: "object" } } as never),
    ).toThrow(/declare the payload once/);
  });
});
