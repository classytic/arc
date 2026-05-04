/**
 * Mongoose adapter — Schema.Types.Mixed strict-AJV compatibility
 *
 * Ensures `Schema.Types.Mixed` fields generate JSON Schema that AJV's
 * `strict: true` mode accepts without `strictTypes` warnings.
 *
 * Background: pre-2.7.1, the adapter emitted
 *   `type: ['string','number','boolean','object','array']`
 * for Mixed fields. AJV strict mode flags union types as `strictTypes`
 * violations and the union also excludes `null`, breaking nullable Mixed
 * fields. The fix is to omit `type` entirely — JSON Schema treats a missing
 * `type` as "any value", which is the right representation for Mixed.
 */

import { buildCrudSchemasFromModel, Repository } from "@classytic/mongokit";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import Ajv from "ajv";
import mongoose, { Schema } from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";

interface IMixedDoc {
  name: string;
  // biome-ignore lint: this IS the test — Mixed accepts any value
  metadata?: any;
}

let Model: mongoose.Model<IMixedDoc>;

beforeAll(() => {
  const TestSchema = new Schema<IMixedDoc>({
    name: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
  });
  Model = mongoose.models.MixedStrict || mongoose.model<IMixedDoc>("MixedStrict", TestSchema);
});

function makeAdapter() {
  const repo = new Repository<IMixedDoc>(Model);
  return createMongooseAdapter({
    model: Model,
    // biome-ignore lint: generic mismatch between MongoKit and adapter
    repository: repo,
    // arc 2.12 cut its built-in fallback. mongokit's
    // `buildCrudSchemasFromModel` is the canonical schema generator and
    // also omits `type` for Mixed (same strict-AJV property tested here).
    schemaGenerator: buildCrudSchemasFromModel,
  });
}

describe("Mongoose adapter: Schema.Types.Mixed → strict-AJV-compatible schema", () => {
  it("Mixed field schema omits the `type` keyword (no union type)", () => {
    const adapter = makeAdapter();
    const schemas = adapter.generateSchemas?.();
    expect(schemas).toBeTruthy();

    const responseProps = (schemas?.response as Record<string, unknown>)?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(responseProps).toBeTruthy();
    expect(responseProps?.metadata).toBeDefined();

    // The Mixed field should NOT have a `type` keyword at all.
    expect("type" in (responseProps?.metadata ?? {})).toBe(false);
  });

  it("AJV compiles the generated response schema with no union-type warnings", () => {
    const adapter = makeAdapter();
    const schemas = adapter.generateSchemas?.();

    // Capture mode warnings via custom logger.
    //
    // Why `strictTypes: false`: AJV strictTypes requires every schema to
    // declare a `type` keyword. Mixed deliberately omits `type` (the JSON
    // Schema "any value" representation) so accept-any semantics work.
    // The two are fundamentally incompatible — AJV strictTypes cannot
    // express "any value" without a union, and unions trigger
    // `allowUnionTypes`. The test's purpose is to verify the schema
    // doesn't regress to the pre-2.7.1 *union* emission that triggered
    // both `strictTypes` AND `allowUnionTypes` warnings; we keep
    // `strict: true` to catch other strict-mode violations.
    const warnings: string[] = [];
    const ajv = new Ajv({
      strict: true,
      strictTypes: false,
      logger: {
        log: () => {},
        warn: (msg: string) => warnings.push(String(msg)),
        error: (msg: string) => warnings.push(String(msg)),
      },
    });

    expect(() => ajv.compile(schemas?.response as object)).not.toThrow();
    // No `allowUnionTypes` warning — Mixed must NOT regress to the
    // type-array form that broke nullable Mixed fields and triggered
    // AJV strict.
    expect(warnings.filter((w) => w.includes("allowUnionTypes"))).toEqual([]);
  });

  it("strict AJV validates a Mixed field accepting any value type", () => {
    const adapter = makeAdapter();
    const schemas = adapter.generateSchemas?.();

    const ajv = new Ajv({ strict: false }); // disable strict to focus on validation behavior
    const validate = ajv.compile(schemas?.response as object);

    // Mixed should accept ANY shape: string, number, boolean, object, array, null
    expect(validate({ name: "x", metadata: "a string" })).toBe(true);
    expect(validate({ name: "x", metadata: 42 })).toBe(true);
    expect(validate({ name: "x", metadata: true })).toBe(true);
    expect(validate({ name: "x", metadata: { nested: "object" } })).toBe(true);
    expect(validate({ name: "x", metadata: [1, 2, 3] })).toBe(true);
    expect(validate({ name: "x", metadata: null })).toBe(true);
    // Optional field — undefined is also fine
    expect(validate({ name: "x" })).toBe(true);
  });
});
