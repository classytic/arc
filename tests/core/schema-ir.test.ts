/**
 * Schema IR — unit tests
 *
 * Locks in the v2.11.x extraction that collapsed arc's two parallel schema
 * translators (`normalizeActionSchema` in createActionRouter for AJV,
 * `convertActionSchemaToZod` in action-tools for MCP) into a single
 * canonical IR plus two adapters.
 *
 * The regression these tests guard against: the old `normalizeActionSchema`
 * returned `{properties, required}` only and silently dropped
 * `additionalProperties` — so an author who declared
 * `additionalProperties: false` in their action schema (the documented
 * escape hatch for strict validation) got the flag stripped before it
 * reached AJV. The IR carries the flag verbatim; both adapters honor it.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  normalizeSchemaIR,
  schemaIRToJsonSchemaBranch,
  schemaIRToZodShape,
  shouldRejectAdditionalProperties,
} from "../../src/core/schemaIR.js";

// ============================================================================
// normalizeSchemaIR — Zod input
// ============================================================================

describe("normalizeSchemaIR — Zod input", () => {
  it("converts a plain z.object() into IR with properties + required", () => {
    const schema = z.object({
      carrier: z.string(),
      trackingId: z.string().optional(),
    });

    const ir = normalizeSchemaIR(schema as unknown as Record<string, unknown>);

    expect(ir.properties).toHaveProperty("carrier");
    expect(ir.properties).toHaveProperty("trackingId");
    expect(ir.required).toContain("carrier");
    expect(ir.required).not.toContain("trackingId");
  });

  it("preserves additionalProperties when the Zod schema is marked strict", () => {
    // z.strictObject() emits `additionalProperties: false` in the JSON Schema
    // representation — the IR must carry it through so AJV enforces strict
    // mode at HTTP validation.
    const schema = z.strictObject({
      carrier: z.string(),
    });

    const ir = normalizeSchemaIR(schema as unknown as Record<string, unknown>);

    expect(ir.additionalProperties).toBe(false);
  });
});

// ============================================================================
// normalizeSchemaIR — JSON Schema input
// ============================================================================

describe("normalizeSchemaIR — JSON Schema input", () => {
  it("reads properties + required from a full JSON Schema object", () => {
    const ir = normalizeSchemaIR({
      type: "object",
      properties: {
        carrier: { type: "string" },
        weight: { type: "number" },
      },
      required: ["carrier"],
    });

    expect(Object.keys(ir.properties)).toEqual(["carrier", "weight"]);
    expect(ir.required).toEqual(["carrier"]);
  });

  it("preserves additionalProperties: false verbatim", () => {
    // This is the core regression: the old normaliser dropped this flag
    // before the branch reached AJV.
    const ir = normalizeSchemaIR({
      type: "object",
      properties: { carrier: { type: "string" } },
      required: ["carrier"],
      additionalProperties: false,
    });

    expect(ir.additionalProperties).toBe(false);
  });

  it("preserves additionalProperties: true verbatim", () => {
    const ir = normalizeSchemaIR({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
    expect(ir.additionalProperties).toBe(true);
  });

  it("preserves additionalProperties object schema verbatim", () => {
    const extra = { type: "string" as const };
    const ir = normalizeSchemaIR({
      type: "object",
      properties: {},
      additionalProperties: extra,
    });
    expect(ir.additionalProperties).toEqual(extra);
  });

  it("omits additionalProperties from IR when the author didn't declare it", () => {
    const ir = normalizeSchemaIR({
      type: "object",
      properties: { carrier: { type: "string" } },
    });
    expect(ir.additionalProperties).toBeUndefined();
  });
});

// ============================================================================
// normalizeSchemaIR — edge cases
// ============================================================================

describe("normalizeSchemaIR — edge cases", () => {
  it("undefined input → empty IR (no throw)", () => {
    const ir = normalizeSchemaIR(undefined);
    expect(ir).toEqual({ properties: {}, required: [] });
  });

  it("non-object input (a string) → empty IR", () => {
    const ir = normalizeSchemaIR("not a schema" as unknown as Record<string, unknown>);
    expect(ir).toEqual({ properties: {}, required: [] });
  });

  it("object without type:'object' or properties → empty IR (bare field-map shape no longer supported)", () => {
    // Post-v2.11 the legacy bare-field-map shape (`{ carrier: { type: 'string' } }`)
    // was removed. It collapses to an empty IR — the schema is treated as
    // "no fields declared" rather than silently being interpreted.
    const ir = normalizeSchemaIR({
      carrier: { type: "string" },
      trackingId: { type: "string" },
    });
    expect(ir.properties).toEqual({});
    expect(ir.required).toEqual([]);
  });
});

// ============================================================================
// schemaIRToJsonSchemaBranch — AJV adapter
// ============================================================================

describe("schemaIRToJsonSchemaBranch", () => {
  it("emits a standalone JSON Schema object from the IR", () => {
    const branch = schemaIRToJsonSchemaBranch({
      properties: { carrier: { type: "string" } },
      required: ["carrier"],
    });

    expect(branch).toEqual({
      type: "object",
      properties: { carrier: { type: "string" } },
      required: ["carrier"],
    });
  });

  it("merges `extras.properties` in FRONT of IR properties (discriminator use case)", () => {
    // This is the shape `buildActionBodySchema` uses: the `action: {const}`
    // discriminator is passed as `extras.properties` so it appears before
    // the author's fields in the generated schema.
    const branch = schemaIRToJsonSchemaBranch(
      {
        properties: { carrier: { type: "string" } },
        required: ["carrier"],
      },
      {
        properties: { action: { type: "string", const: "dispatch" } },
        required: ["action"],
      },
    );

    expect(branch.properties).toHaveProperty("action");
    expect(branch.properties).toHaveProperty("carrier");
    const required = branch.required as string[];
    expect(required).toEqual(["action", "carrier"]);
  });

  it("preserves additionalProperties: false from the IR (the core regression fix)", () => {
    const branch = schemaIRToJsonSchemaBranch({
      properties: { carrier: { type: "string" } },
      required: ["carrier"],
      additionalProperties: false,
    });

    expect(branch.additionalProperties).toBe(false);
  });

  it("omits additionalProperties entirely when the IR doesn't declare it", () => {
    const branch = schemaIRToJsonSchemaBranch({
      properties: { carrier: { type: "string" } },
      required: ["carrier"],
    });

    expect(branch).not.toHaveProperty("additionalProperties");
  });

  it("deduplicates required fields when extras.required overlaps with IR required", () => {
    const branch = schemaIRToJsonSchemaBranch(
      {
        properties: { action: { type: "string" }, carrier: { type: "string" } },
        required: ["action", "carrier"],
      },
      {
        properties: {},
        required: ["action"],
      },
    );

    const required = branch.required as string[];
    // `action` should appear once — extras takes precedence, IR's duplicate drops
    expect(required.filter((r) => r === "action")).toHaveLength(1);
    expect(required).toContain("carrier");
  });
});

// ============================================================================
// schemaIRToZodShape — MCP adapter
// ============================================================================

describe("schemaIRToZodShape", () => {
  it("emits a flat Zod shape from the IR", () => {
    const shape = schemaIRToZodShape({
      properties: { carrier: { type: "string" } },
      required: ["carrier"],
    });

    expect(Object.keys(shape)).toEqual(["carrier"]);
    // Each entry is a ZodType
    expect(typeof shape.carrier).toBe("object");
    expect(shape.carrier).toHaveProperty("parse");
  });

  it("marks non-required fields as optional via .optional()", () => {
    const shape = schemaIRToZodShape({
      properties: {
        carrier: { type: "string" },
        trackingId: { type: "string" },
      },
      required: ["carrier"],
    });

    // Required field parses undefined as a failure
    expect(() => shape.carrier.parse(undefined)).toThrow();
    // Optional field parses undefined as success
    expect(shape.trackingId.parse(undefined)).toBeUndefined();
  });

  it("maps JSON Schema types to corresponding Zod types", () => {
    const shape = schemaIRToZodShape({
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        ratio: { type: "number" },
        active: { type: "boolean" },
        tags: { type: "array" },
        meta: { type: "object" },
      },
      required: ["name", "count", "ratio", "active", "tags", "meta"],
    });

    expect(() => shape.name.parse("hello")).not.toThrow();
    expect(() => shape.count.parse(42)).not.toThrow();
    expect(() => shape.ratio.parse(3.14)).not.toThrow();
    expect(() => shape.active.parse(true)).not.toThrow();
    expect(() => shape.tags.parse([1, 2, 3])).not.toThrow();
    expect(() => shape.meta.parse({ k: "v" })).not.toThrow();
    // Wrong types rejected
    expect(() => shape.count.parse("not-a-number")).toThrow();
    expect(() => shape.active.parse("true")).toThrow();
  });

  it("honors enum with z.enum", () => {
    const shape = schemaIRToZodShape({
      properties: {
        status: { type: "string", enum: ["active", "archived"] },
      },
      required: ["status"],
    });

    expect(() => shape.status.parse("active")).not.toThrow();
    expect(() => shape.status.parse("unknown")).toThrow();
  });

  it("empty IR → empty shape (no properties, no throw)", () => {
    const shape = schemaIRToZodShape({ properties: {}, required: [] });
    expect(Object.keys(shape)).toEqual([]);
  });
});

// ============================================================================
// shouldRejectAdditionalProperties — strict-mode detector
// ============================================================================

describe("shouldRejectAdditionalProperties", () => {
  it("returns true ONLY when additionalProperties is strictly false", () => {
    expect(
      shouldRejectAdditionalProperties({
        properties: {},
        required: [],
        additionalProperties: false,
      }),
    ).toBe(true);
  });

  it("returns false when additionalProperties is undefined (default permissive)", () => {
    expect(shouldRejectAdditionalProperties({ properties: {}, required: [] })).toBe(false);
  });

  it("returns false when additionalProperties is true (explicit permissive)", () => {
    expect(
      shouldRejectAdditionalProperties({
        properties: {},
        required: [],
        additionalProperties: true,
      }),
    ).toBe(false);
  });

  it("returns false when additionalProperties is an object schema (allow with shape)", () => {
    expect(
      shouldRejectAdditionalProperties({
        properties: {},
        required: [],
        additionalProperties: { type: "string" },
      }),
    ).toBe(false);
  });
});
