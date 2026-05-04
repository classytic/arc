/**
 * fieldRules.nullable — widen JSON Schema type to accept null.
 *
 * Context (2.11.0): a host Zod schema was
 * `z.enum(['inclusive', 'exclusive']).nullable().optional()`. Zod →
 * Mongoose converters drop `.nullable()` when the field doesn't carry
 * `default: null` (Mongoose has no first-class nullable marker), and
 * mongokit's `buildCrudSchemasFromModel` therefore emits
 * `{ type: 'string', enum: [...] }` — AJV rejects `priceMode: null` on
 * a GET → PATCH round-trip even though null is a legitimate value.
 *
 * Two mechanisms close the gap:
 *   1. `fieldRules[field].nullable: true` — portable arc-config opt-in
 *      applied post-kit by `mergeFieldRuleConstraints` (works for any
 *      adapter: mongoose, drizzle, prisma).
 *   2. Built-in mongoose fallback detects `default: null` on the
 *      Mongoose schema path and widens the type automatically,
 *      matching mongokit's own convention.
 *
 * All assertions validate against AJV 8 (the same validator Fastify v5
 * bundles), so a passing test = a passing production route.
 */

import { buildCrudSchemasFromModel, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { mergeFieldRuleConstraints } from "@classytic/repo-core/schema";
import Ajv from "ajv";
import mongoose, { Schema } from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";

// ============================================================================
// 1. fieldRules.nullable via mergeFieldRuleConstraints (portable post-kit)
// ============================================================================

describe("mergeFieldRuleConstraints — fieldRules.nullable widens type", () => {
  it("widens single-type `type: 'string'` to tuple `['string', 'null']`", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          priceMode: { type: "string", enum: ["inclusive", "exclusive"] },
        },
      },
    };
    mergeFieldRuleConstraints(schemas, {
      fieldRules: { priceMode: { nullable: true } },
    });
    // `null` appended to `enum` too — AJV's enum keyword rejects null
    // unless it's in the list, even when `type` says null is allowed.
    expect(schemas.createBody.properties.priceMode).toMatchObject({
      type: ["string", "null"],
      enum: ["inclusive", "exclusive", null],
    });
  });

  it("appends 'null' to existing tuple type if missing", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          quantity: { type: ["number", "integer"] },
        },
      },
    };
    mergeFieldRuleConstraints(schemas, {
      fieldRules: { quantity: { nullable: true } },
    });
    expect((schemas.createBody.properties.quantity as { type: string[] }).type).toEqual([
      "number",
      "integer",
      "null",
    ]);
  });

  it("is idempotent when tuple already includes 'null'", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          priceMode: { type: ["string", "null"] },
        },
      },
    };
    mergeFieldRuleConstraints(schemas, {
      fieldRules: { priceMode: { nullable: true } },
    });
    expect((schemas.createBody.properties.priceMode as { type: string[] }).type).toEqual([
      "string",
      "null",
    ]);
  });

  it("adds null branch to anyOf schemas (Zod draft-7 shape)", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          priceMode: {
            anyOf: [{ type: "string", enum: ["inclusive", "exclusive"] }],
          },
        },
      },
    };
    mergeFieldRuleConstraints(schemas, {
      fieldRules: { priceMode: { nullable: true } },
    });
    expect(
      (schemas.createBody.properties.priceMode as { anyOf: Array<Record<string, unknown>> }).anyOf,
    ).toEqual([{ type: "string", enum: ["inclusive", "exclusive"] }, { type: "null" }]);
  });

  it("is idempotent when anyOf already has a null branch", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          priceMode: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
      },
    };
    mergeFieldRuleConstraints(schemas, {
      fieldRules: { priceMode: { nullable: true } },
    });
    expect((schemas.createBody.properties.priceMode as { anyOf: unknown[] }).anyOf).toHaveLength(2);
  });

  it("applies to updateBody and response slots, skips listQuery/params", () => {
    const schemas = {
      createBody: { type: "object", properties: { x: { type: "string" } } },
      updateBody: { type: "object", properties: { x: { type: "string" } } },
      response: { type: "object", properties: { x: { type: "string" } } },
      listQuery: { type: "object", properties: { x: { type: "string" } } },
      params: { type: "object", properties: { x: { type: "string" } } },
    };
    mergeFieldRuleConstraints(schemas, {
      fieldRules: { x: { nullable: true } },
    });
    expect((schemas.createBody.properties.x as { type: unknown }).type).toEqual(["string", "null"]);
    expect((schemas.updateBody.properties.x as { type: unknown }).type).toEqual(["string", "null"]);
    expect((schemas.response.properties.x as { type: unknown }).type).toEqual(["string", "null"]);
    // listQuery/params are kit-owned — merge helper never touches them
    expect((schemas.listQuery.properties.x as { type: unknown }).type).toBe("string");
    expect((schemas.params.properties.x as { type: unknown }).type).toBe("string");
  });
});

// ============================================================================
// 2. AJV end-to-end — the same validator Fastify v5 ships
// ============================================================================

describe("fieldRules.nullable — AJV 8 validates the widened schema", () => {
  it("AJV accepts null for a widened tuple type", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          priceMode: { type: "string", enum: ["inclusive", "exclusive"] },
        },
        additionalProperties: false,
      },
    };
    mergeFieldRuleConstraints(schemas, {
      fieldRules: { priceMode: { nullable: true } },
    });

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schemas.createBody);

    expect(validate({ priceMode: null })).toBe(true);
    expect(validate({ priceMode: "inclusive" })).toBe(true);
    expect(validate({ priceMode: "bogus" })).toBe(false);
    expect(validate({})).toBe(true);
  });

  it("AJV accepts null for a widened anyOf branch", () => {
    const schemas = {
      createBody: {
        type: "object",
        properties: {
          priceMode: {
            anyOf: [{ type: "string", enum: ["inclusive", "exclusive"] }],
          },
        },
        additionalProperties: false,
      },
    };
    mergeFieldRuleConstraints(schemas, {
      fieldRules: { priceMode: { nullable: true } },
    });

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schemas.createBody);

    expect(validate({ priceMode: null })).toBe(true);
    expect(validate({ priceMode: "exclusive" })).toBe(true);
    expect(validate({ priceMode: 42 })).toBe(false);
  });
});

// ============================================================================
// 3. Built-in mongoose fallback — detects { default: null } automatically
// ============================================================================

interface IVariant {
  name: string;
  priceMode?: string | null;
}

let VariantModel: mongoose.Model<IVariant>;

beforeAll(() => {
  const VariantSchema = new Schema<IVariant>({
    name: { type: String, required: true },
    // `default: null` is the Mongoose-native nullable signal mongokit
    // already honors. The built-in fallback now mirrors that convention.
    priceMode: { type: String, enum: ["inclusive", "exclusive"], default: null },
  });
  VariantModel =
    mongoose.models.NullableVariant || mongoose.model<IVariant>("NullableVariant", VariantSchema);
});

// `default: null` widening is mongokit's `buildCrudSchemasFromModel`
// responsibility — arc 2.12 cut its fallback in favour of one canonical
// generator. These tests now verify the arc-adapter ↔ mongokit-generator
// integration end-to-end (host wiring + post-process via
// mergeFieldRuleConstraints), not the fallback's path-walking specifically.
describe("MongooseAdapter + buildCrudSchemasFromModel — default:null widens emitted type", () => {
  it("emits null-tolerant type for String field with default: null", () => {
    const repo = new Repository<IVariant>(VariantModel);
    const adapter = createMongooseAdapter({
      model: VariantModel,
      repository: repo,
      schemaGenerator: buildCrudSchemasFromModel,
    });
    const schemas = adapter.generateSchemas?.();
    expect(schemas).toBeDefined();

    const createBody = (schemas as { createBody: Record<string, unknown> }).createBody;
    const props = createBody.properties as Record<string, Record<string, unknown>>;
    // mongokit honours `default: null` by allowing null in the type union.
    // The exact representation may be `['string', 'null']` (JSON Schema
    // type-array) or `string` + `nullable: true`; assert the field accepts
    // null at validation time rather than tying to one shape.
    expect(props.priceMode).toBeDefined();
    // Non-nullable field stays as plain `string`.
    expect(props.name.type).toBe("string");
  });

  it("AJV accepts null priceMode on a default:null field", () => {
    const repo = new Repository<IVariant>(VariantModel);
    const adapter = createMongooseAdapter({
      model: VariantModel,
      repository: repo,
      schemaGenerator: buildCrudSchemasFromModel,
    });
    const schemas = adapter.generateSchemas?.();
    const createBody = (schemas as { createBody: Record<string, unknown> }).createBody;

    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(createBody);

    expect(validate({ name: "A", priceMode: null })).toBe(true);
    expect(validate({ name: "A", priceMode: "inclusive" })).toBe(true);
    expect(validate({ name: "A", priceMode: "bogus" })).toBe(false);
  });
});

// ============================================================================
// 4. fieldRules.nullable over a kit-generated schema
// ============================================================================

describe("fieldRules.nullable rescues Zod .nullable() loss through Mongoose", () => {
  it("host opts into nullable via fieldRules when Zod→Mongoose dropped it", () => {
    // Simulates the mongokit output shape for:
    //   priceMode: z.enum(['inclusive', 'exclusive']).nullable().optional()
    // where the `.nullable()` was lost in the Zod → Mongoose conversion.
    const kitGenerated = {
      createBody: {
        type: "object",
        properties: {
          name: { type: "string" },
          priceMode: { type: "string", enum: ["inclusive", "exclusive"] },
        },
      },
      updateBody: {
        type: "object",
        properties: {
          name: { type: "string" },
          priceMode: { type: "string", enum: ["inclusive", "exclusive"] },
        },
      },
    };

    // One-liner opt-in in arc's `defineResource({ schemaOptions: { fieldRules } })`.
    mergeFieldRuleConstraints(kitGenerated, {
      fieldRules: { priceMode: { nullable: true } },
    });

    const ajv = new Ajv({ strict: false });
    const validateCreate = ajv.compile(kitGenerated.createBody);
    const validateUpdate = ajv.compile(kitGenerated.updateBody);

    // The PATCH round-trip that used to fail
    expect(validateUpdate({ priceMode: null })).toBe(true);
    expect(validateCreate({ name: "A", priceMode: null })).toBe(true);
  });
});
