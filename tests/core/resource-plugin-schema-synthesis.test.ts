/**
 * Schema-synthesis pure-function unit tests
 *
 * `buildGeneratedCrudSchemas` is the pure function pulled out of
 * `toPlugin()`'s plugin closure: given an adapter's OpenApiSchemas + the
 * resource's customSchemas, it produces the per-CRUD-op schema map
 * (`{ create: { body }, update: { body, params }, get: { params }, delete: { params } }`)
 * that `createCrudRouter` consumes.
 *
 * The reason this is its own file: the previous inline implementation
 * shared `params` references across 3+ CRUD slots (`generated.get =
 * { params }; generated.delete = { params }; generated.update.params =
 * params`), so any downstream mutation of one operation's params schema
 * would leak into the others. Vendor extensions, AJV `$ref` decoration,
 * description overrides — all classes of edits that could quietly
 * cross-contaminate the schema for other operations.
 *
 * The function now clones `params` per slot. These tests pin that
 * contract.
 */

import { describe, expect, it } from "vitest";
import { buildGeneratedCrudSchemas } from "../../src/core/defineResource/plugin.js";

describe("buildGeneratedCrudSchemas", () => {
  it("returns null when neither openApi nor customSchemas provide anything to generate", () => {
    expect(buildGeneratedCrudSchemas(undefined, undefined)).toBeNull();
    expect(buildGeneratedCrudSchemas(undefined, {})).toBeNull();
  });

  it("produces independent `params` references per CRUD slot", () => {
    const openApi = {
      params: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      createBody: { type: "object", properties: { name: { type: "string" } } },
      updateBody: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };

    const schemas = buildGeneratedCrudSchemas(openApi, undefined);
    expect(schemas).not.toBeNull();
    const result = schemas!;

    // Every slot that holds `params` must hold its OWN reference.
    expect(result.get?.params).not.toBe(result.delete?.params);
    expect(result.get?.params).not.toBe(result.update?.params);
    expect(result.delete?.params).not.toBe(result.update?.params);

    // Mutating one slot's params must NOT leak into others.
    (result.get?.params as { mutated?: boolean }).mutated = true;
    expect((result.delete?.params as { mutated?: boolean }).mutated).toBeUndefined();
    expect((result.update?.params as { mutated?: boolean }).mutated).toBeUndefined();
  });

  it("strips `required` from update body so PATCH semantics apply", () => {
    const openApi = {
      params: { type: "object", properties: { id: { type: "string" } } },
      updateBody: {
        type: "object",
        properties: { name: { type: "string" }, price: { type: "number" } },
        required: ["name"],
      },
    };

    const result = buildGeneratedCrudSchemas(openApi, undefined);
    expect((result?.update?.body as { required?: unknown }).required).toBeUndefined();
  });

  it("defaults body schemas to `additionalProperties: true` to avoid extractor rejection", () => {
    const openApi = {
      createBody: { type: "object", properties: { name: { type: "string" } } },
    };
    const result = buildGeneratedCrudSchemas(openApi, undefined);
    expect((result?.create?.body as { additionalProperties?: unknown }).additionalProperties).toBe(
      true,
    );
  });

  it("preserves an explicit `additionalProperties: false` from the adapter", () => {
    const openApi = {
      createBody: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    };
    const result = buildGeneratedCrudSchemas(openApi, undefined);
    expect((result?.create?.body as { additionalProperties?: unknown }).additionalProperties).toBe(
      false,
    );
  });

  it("customSchemas layers per-slot on top of auto-gen (touched slots merge, untouched stay)", () => {
    // Post-2.12 contract: declaring `customSchemas.create` no longer
    // wholesale-disables generated `get`/`update`/`delete`/`params`
    // schemas. The auto-gen runs unconditionally; customSchemas
    // deep-merges per slot on top.
    //
    // Merge precedence: deep-merged shapes (customSchemas wins on
    // primitive collisions, properties union). Untouched slots keep
    // their adapter-derived contents intact.
    const openApi = {
      createBody: {
        type: "object",
        properties: { name: { type: "string" } },
      },
      updateBody: {
        type: "object",
        properties: { name: { type: "string" } },
      },
      params: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    };
    const customSchemas = {
      // Touched slot — merges with auto-gen createBody
      create: {
        body: {
          type: "object",
          properties: { extra: { type: "boolean" } },
        },
      },
    };

    const result = buildGeneratedCrudSchemas(openApi, customSchemas);
    const createBody = result?.create?.body as { properties?: Record<string, unknown> };
    // Touched slot — deep-merged: both `name` (auto-gen) and `extra`
    // (custom) survive.
    expect(createBody.properties).toHaveProperty("name");
    expect(createBody.properties).toHaveProperty("extra");

    // Untouched slots — keep auto-gen verbatim. Pre-fix this would
    // have been undefined because `customSchemas.create` triggered a
    // wholesale skip.
    expect(result?.update?.body).toBeDefined();
    expect(result?.get?.params).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(result?.delete?.params).toBeDefined();
  });
});
