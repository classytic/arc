/**
 * `buildGeneratedCrudSchemas` — adapter `OpenApiSchemas` + the resource's
 * `customSchemas` → the per-op schema map `createCrudRouter` consumes.
 *
 * The contract these pin: `params` is CLONED per slot. Sharing one reference
 * across get/delete/update let any downstream mutation — a vendor extension,
 * AJV `$ref` decoration, a description override — cross-contaminate the other
 * operations' schemas.
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

  /**
   * Regression — real defect: `delete patchBody.required` only removed the
   * TOP-LEVEL key. A schema generator (e.g. mongokit's Mongoose introspection)
   * can hand back an `updateBody` whose subdocument-array `items` schema
   * carries its OWN `required` array — a product `variants: [{ sku,
   * attributes }]` field, for instance — and that nested `required` survived
   * untouched. Fastify/AJV then rejected a PATCH adding one variant with a
   * genuinely-empty-but-present `attributes: {}`, because the generated
   * PATCH schema still demanded the key at `variants.items.required`.
   */
  it("strips `required` from a nested subdocument-array item's schema too, not just the top level", () => {
    const openApi = {
      params: { type: "object", properties: { id: { type: "string" } } },
      updateBody: {
        type: "object",
        properties: {
          variants: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sku: { type: "string" },
                attributes: { additionalProperties: true },
              },
              required: ["sku", "attributes"],
            },
          },
        },
      },
    };

    const result = buildGeneratedCrudSchemas(openApi, undefined);
    const body = result?.update?.body as {
      properties?: { variants?: { items?: { required?: unknown } } };
    };
    expect(body.properties?.variants?.items?.required).toBeUndefined();
  });

  it("deep-stripping `required` for the PATCH copy does not mutate the source updateBody", () => {
    // `stripRequiredDeep` mutates in place — the function MUST clone before
    // stripping, or a shared `openApiSchemas.updateBody` reference (read by
    // OpenAPI docgen, or reused across resource registration) would lose its
    // nested `required` arrays too, not just the PATCH copy this function
    // hands to the update route.
    const updateBody = {
      type: "object",
      properties: {
        variants: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" } },
            required: ["sku"],
          },
        },
      },
    };
    const openApi = {
      params: { type: "object", properties: { id: { type: "string" } } },
      updateBody,
    };

    buildGeneratedCrudSchemas(openApi, undefined);

    expect(updateBody.properties.variants.items.required).toEqual(["sku"]);
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

  it("customSchemas layers per-slot on top of auto-gen (touched PARTS replace, untouched stay)", () => {
    // Post-2.12 contract: declaring `customSchemas.create` no longer
    // wholesale-disables generated `get`/`update`/`delete`/`params`
    // schemas. The auto-gen runs unconditionally; customSchemas layers
    // per slot on top.
    //
    // 2.21 precedence change: a customised schema PART (body/params/...)
    // REPLACES the generated part wholesale — a body schema is a complete
    // wire contract, not a patch. The pre-2.21 deep-merge unioned
    // `required[]`/properties across two DIFFERENT wire shapes, which
    // 400'd every legacy-wire create once mongokit 3.21 turned generated
    // schemas on by default (caught live on 28 production resources).
    // Parts the custom schema does NOT touch keep their auto-gen intact.
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
    // Touched PART — custom body replaces the generated body wholesale:
    // only the custom contract's fields remain.
    expect(createBody.properties).toHaveProperty("extra");
    expect(createBody.properties).not.toHaveProperty("name");

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
