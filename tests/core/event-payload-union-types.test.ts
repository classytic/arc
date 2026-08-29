/**
 * A JSON Schema UNION type (`['string','null']`) must validate.
 *
 * That is how every nullable field compiles, and `validate` compared the whole
 * `type` ARRAY against a `typeof` string. Never equal — so a nullable field
 * rejected every value it allows, including `null` itself, and the array
 * stringified into the message as "expected string,null, got string": an error
 * that names the passing type as the failure.
 *
 * It surfaced as a 400 on an order refund (`accounting:cod.cancelled` carries
 * `customerId: z.string().nullable().optional()`), i.e. a money path blocked by
 * a validator that could not express the schema it was given.
 */
import { describe, expect, it } from "vitest";
import { createEventRegistry, defineEvent } from "../../src/events/defineEvent.js";

const registry = createEventRegistry();
registry.register(
  defineEvent({
    name: "test:nullable.union",
    schema: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        customerId: { type: ["string", "null"] },
        seats: { type: ["integer", "null"] },
      },
      required: ["orderId"],
    },
  }),
);

const validate = (payload: unknown) => registry.validate("test:nullable.union", payload);

describe("event payload union types", () => {
  it("accepts the STRING arm of a nullable field", () => {
    const r = validate({ orderId: "ORD-1", customerId: "cus_123" });
    expect(r.errors ?? []).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("accepts the NULL arm", () => {
    expect(validate({ orderId: "ORD-1", customerId: null }).valid).toBe(true);
  });

  it("accepts an omitted optional field", () => {
    expect(validate({ orderId: "ORD-1" }).valid).toBe(true);
  });

  it("still REJECTS a type outside the union, and names the arms", () => {
    const r = validate({ orderId: "ORD-1", customerId: 42 });
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]).toContain("expected string | null, got number");
  });

  it("keeps the integer constraint inside a union", () => {
    // `integer` is a numeric constraint, not a typeof — 1.5 is a number but not an integer.
    expect(validate({ orderId: "ORD-1", seats: 3 }).valid).toBe(true);
    expect(validate({ orderId: "ORD-1", seats: null }).valid).toBe(true);
    expect(validate({ orderId: "ORD-1", seats: 1.5 }).valid).toBe(false);
  });

  it("single (non-union) types are unchanged", () => {
    expect(validate({ orderId: "ORD-1" }).valid).toBe(true);
    expect(validate({ orderId: 7 }).valid).toBe(false);
  });
});
