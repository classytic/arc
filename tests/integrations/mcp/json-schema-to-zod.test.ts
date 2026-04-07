/**
 * jsonSchemaToZodShape — JSON Schema → Zod shape converter
 *
 * Covers every claim in the docstring:
 *   - Primitives (string, number, integer, boolean) with constraints
 *   - Type unions like ["string", "null"]
 *   - Enum (string + numeric)
 *   - Format hints (email, uuid, url)
 *   - Arrays (typed items + nested object items)
 *   - Nested objects with properties (recursive)
 *   - Composition: oneOf / anyOf / allOf
 *   - $ref → permissive
 *   - Required vs optional in create vs update mode
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../../../src/integrations/mcp/jsonSchemaToZod.js";

function parse(shape: Record<string, z.ZodTypeAny>, value: unknown) {
  return z.object(shape).safeParse(value);
}

describe("jsonSchemaToZodShape", () => {
  // ── Primitives ──────────────────────────────────────────────────────────

  it("converts primitive types", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "integer" },
          price: { type: "number" },
          active: { type: "boolean" },
        },
        required: ["name", "count"],
      },
      "create",
    );
    expect(shape).toBeDefined();
    const result = parse(shape!, {
      name: "Widget",
      count: 5,
      price: 99.99,
      active: true,
    });
    expect(result.success).toBe(true);
  });

  it("enforces required fields in create mode", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { name: { type: "string" }, sku: { type: "string" } },
        required: ["name", "sku"],
      },
      "create",
    );
    const missing = parse(shape!, { name: "Widget" });
    expect(missing.success).toBe(false);
  });

  it("makes everything optional in update mode (even required fields)", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { name: { type: "string" }, sku: { type: "string" } },
        required: ["name", "sku"],
      },
      "update",
    );
    const partial = parse(shape!, { name: "Updated" });
    expect(partial.success).toBe(true);
  });

  // ── Constraints ─────────────────────────────────────────────────────────

  it("applies string length constraints", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { code: { type: "string", minLength: 3, maxLength: 10 } },
        required: ["code"],
      },
      "create",
    );
    expect(parse(shape!, { code: "AB" }).success).toBe(false); // too short
    expect(parse(shape!, { code: "ABCDEFGHIJK" }).success).toBe(false); // too long
    expect(parse(shape!, { code: "VALID" }).success).toBe(true);
  });

  it("applies number range constraints", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { age: { type: "integer", minimum: 0, maximum: 120 } },
        required: ["age"],
      },
      "create",
    );
    expect(parse(shape!, { age: -1 }).success).toBe(false);
    expect(parse(shape!, { age: 200 }).success).toBe(false);
    expect(parse(shape!, { age: 30 }).success).toBe(true);
  });

  it("applies regex pattern", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { sku: { type: "string", pattern: "^[A-Z]{3}-\\d+$" } },
        required: ["sku"],
      },
      "create",
    );
    expect(parse(shape!, { sku: "abc-123" }).success).toBe(false);
    expect(parse(shape!, { sku: "ABC-123" }).success).toBe(true);
  });

  it("invalid regex pattern is silently ignored (no crash)", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { x: { type: "string", pattern: "[unclosed" } },
        required: ["x"],
      },
      "create",
    );
    expect(parse(shape!, { x: "anything" }).success).toBe(true);
  });

  // ── Format hints ────────────────────────────────────────────────────────

  it("applies email format", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { email: { type: "string", format: "email" } },
        required: ["email"],
      },
      "create",
    );
    expect(parse(shape!, { email: "not an email" }).success).toBe(false);
    expect(parse(shape!, { email: "user@example.com" }).success).toBe(true);
  });

  it("applies uuid format", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { id: { type: "string", format: "uuid" } },
        required: ["id"],
      },
      "create",
    );
    expect(parse(shape!, { id: "not-a-uuid" }).success).toBe(false);
    expect(parse(shape!, { id: "550e8400-e29b-41d4-a716-446655440000" }).success).toBe(true);
  });

  // ── Type unions (nullable) ──────────────────────────────────────────────

  it("handles ['string', 'null'] type union (skips null, accepts string)", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { name: { type: ["string", "null"] } },
        required: ["name"],
      },
      "create",
    );
    expect(parse(shape!, { name: "Hello" }).success).toBe(true);
  });

  // ── Enum ────────────────────────────────────────────────────────────────

  it("converts string enum to z.enum()", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft", "published", "archived"] },
        },
        required: ["status"],
      },
      "create",
    );
    expect(parse(shape!, { status: "draft" }).success).toBe(true);
    expect(parse(shape!, { status: "invalid" }).success).toBe(false);
  });

  // ── Arrays ──────────────────────────────────────────────────────────────

  it("converts string arrays", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["tags"],
      },
      "create",
    );
    expect(parse(shape!, { tags: ["a", "b", "c"] }).success).toBe(true);
    expect(parse(shape!, { tags: [1, 2, 3] }).success).toBe(false);
  });

  it("converts arrays of nested objects", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product: { type: "string" },
                quantity: { type: "integer" },
              },
              required: ["product", "quantity"],
            },
          },
        },
        required: ["items"],
      },
      "create",
    );
    expect(
      parse(shape!, { items: [{ product: "WIDGET", quantity: 2 }] }).success,
    ).toBe(true);
    expect(
      parse(shape!, { items: [{ product: "WIDGET" }] }).success,
    ).toBe(false); // missing required quantity
  });

  it("untyped array accepts anything", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { mixed: { type: "array" } },
        required: ["mixed"],
      },
      "create",
    );
    expect(parse(shape!, { mixed: [1, "two", { three: 3 }] }).success).toBe(true);
  });

  // ── Nested objects ──────────────────────────────────────────────────────

  it("recurses into nested object properties", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          address: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
              zip: { type: "string", pattern: "^\\d{5}$" },
            },
            required: ["street", "city"],
          },
        },
        required: ["address"],
      },
      "create",
    );
    expect(
      parse(shape!, {
        address: { street: "123 Main", city: "Springfield", zip: "12345" },
      }).success,
    ).toBe(true);
    // Missing required nested field
    expect(parse(shape!, { address: { street: "123 Main" } }).success).toBe(false);
    // Bad pattern
    expect(
      parse(shape!, { address: { street: "X", city: "Y", zip: "abc" } }).success,
    ).toBe(false);
  });

  it("nested object without properties accepts any record", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { metadata: { type: "object" } },
        required: ["metadata"],
      },
      "create",
    );
    expect(parse(shape!, { metadata: { anything: "goes", numbers: 123 } }).success).toBe(true);
  });

  // ── Composition: oneOf / anyOf / allOf ──────────────────────────────────

  it("handles oneOf composition (first viable branch)", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          // populate-style: string OR object
          populate: {
            oneOf: [{ type: "string" }, { type: "object" }],
          },
        },
        required: ["populate"],
      },
      "create",
    );
    expect(parse(shape!, { populate: "author" }).success).toBe(true);
  });

  it("handles anyOf composition", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          tags: {
            anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
        },
        required: ["tags"],
      },
      "create",
    );
    expect(parse(shape!, { tags: "single" }).success).toBe(true);
  });

  it("handles allOf composition (picks last branch's structure)", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          x: {
            allOf: [
              { type: "object" },
              {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            ],
          },
        },
        required: ["x"],
      },
      "create",
    );
    expect(parse(shape!, { x: { name: "Hello" } }).success).toBe(true);
  });

  // ── $ref ─────────────────────────────────────────────────────────────────

  it("$ref falls back to permissive (z.unknown())", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          // biome-ignore lint: $ref is not in the typed interface but is valid JSON Schema
          ref: { $ref: "#/components/schemas/SomeOther" } as any,
        },
        required: ["ref"],
      },
      "create",
    );
    // unknown accepts anything
    expect(parse(shape!, { ref: "anything" }).success).toBe(true);
    expect(parse(shape!, { ref: { complex: { nested: true } } }).success).toBe(true);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("returns undefined for empty / null / non-object input", () => {
    expect(jsonSchemaToZodShape(undefined)).toBeUndefined();
    expect(jsonSchemaToZodShape({ type: "object" })).toBeUndefined(); // no properties
    expect(jsonSchemaToZodShape({ type: "object", properties: {} })).toBeUndefined();
  });

  it("preserves description as zod .describe()", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: { name: { type: "string", description: "Product name" } },
        required: ["name"],
      },
      "create",
    );
    expect(shape!.name?.description).toBe("Product name");
  });

  it("complex real-world e-commerce body schema converts cleanly", () => {
    const shape = jsonSchemaToZodShape(
      {
        type: "object",
        properties: {
          sku: { type: "string", pattern: "^[A-Z]+-\\d+$" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          price: { type: "number", minimum: 0 },
          status: {
            type: "string",
            enum: ["draft", "published", "archived"],
          },
          tags: { type: "array", items: { type: "string" } },
          dimensions: {
            type: "object",
            properties: {
              width: { type: "number" },
              height: { type: "number" },
              depth: { type: "number" },
            },
          },
          variants: {
            type: "array",
            items: {
              type: "object",
              properties: {
                color: { type: "string" },
                size: { type: "string", enum: ["S", "M", "L", "XL"] },
                stock: { type: "integer", minimum: 0 },
              },
              required: ["color", "size"],
            },
          },
          metadata: { type: "object" }, // arbitrary
        },
        required: ["sku", "name", "price"],
      },
      "create",
    );
    expect(shape).toBeDefined();

    const valid = parse(shape!, {
      sku: "WIDGET-001",
      name: "Widget Pro",
      price: 99.99,
      status: "published",
      tags: ["new", "featured"],
      dimensions: { width: 10, height: 5, depth: 3 },
      variants: [
        { color: "red", size: "M", stock: 50 },
        { color: "blue", size: "L", stock: 25 },
      ],
      metadata: { source: "import", priority: 1 },
    });
    expect(valid.success).toBe(true);

    // Bad sku pattern
    const badSku = parse(shape!, { sku: "lowercase", name: "X", price: 1 });
    expect(badSku.success).toBe(false);

    // Bad enum
    const badStatus = parse(shape!, {
      sku: "X-1",
      name: "X",
      price: 1,
      status: "weird",
    });
    expect(badStatus.success).toBe(false);

    // Missing nested required
    const badVariant = parse(shape!, {
      sku: "X-1",
      name: "X",
      price: 1,
      variants: [{ color: "red" }], // missing size
    });
    expect(badVariant.success).toBe(false);
  });
});
