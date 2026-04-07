/**
 * PATCH Schema Generation Tests
 *
 * Verifies that auto-generated PATCH schemas properly make all fields
 * optional while preserving per-field validation constraints.
 */

import { describe, expect, it } from "vitest";

/**
 * Simulates the PATCH schema generation logic from defineResource.
 * We extract and test this independently.
 */
function generatePatchSchema(createBody: Record<string, unknown>): Record<string, unknown> {
  // The correct approach: make each field optional by removing `required`,
  // but preserve per-field constraints (minLength, minimum, format, etc.)
  const patchBody = { ...createBody };
  delete patchBody.required;

  // Mark all properties as optional in a JSON Schema-compatible way
  // By removing `required`, all fields become optional.
  // Individual field constraints (minLength, minimum, pattern, etc.)
  // are preserved so that when a field IS provided, it's validated.
  return patchBody;
}

describe("PATCH Schema Generation", () => {
  it("should remove required array from create schema", () => {
    const createBody = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        email: { type: "string", format: "email" },
        age: { type: "number", minimum: 0 },
      },
      required: ["name", "email"],
    };

    const patchBody = generatePatchSchema(createBody);

    // required should be removed
    expect(patchBody.required).toBeUndefined();

    // But field-level constraints MUST be preserved
    const props = patchBody.properties as Record<string, any>;
    expect(props.name.minLength).toBe(1);
    expect(props.email.format).toBe("email");
    expect(props.age.minimum).toBe(0);
  });

  it("should preserve nested object constraints", () => {
    const createBody = {
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string", minLength: 1 },
            city: { type: "string" },
          },
          required: ["street"],
        },
      },
      required: ["address"],
    };

    const patchBody = generatePatchSchema(createBody);

    // Top-level required removed
    expect(patchBody.required).toBeUndefined();

    // Nested required preserved — when address IS sent, street is still required
    const addressSchema = (patchBody.properties as any).address;
    expect(addressSchema.required).toEqual(["street"]);
  });

  it("should handle schema with no required array", () => {
    const createBody = {
      type: "object",
      properties: {
        description: { type: "string" },
      },
    };

    const patchBody = generatePatchSchema(createBody);
    expect(patchBody.required).toBeUndefined();
    expect((patchBody.properties as any).description.type).toBe("string");
  });
});
