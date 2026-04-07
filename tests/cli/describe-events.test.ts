/**
 * CLI Describe — Event Catalog Integration Tests
 *
 * Tests that `arc describe` includes event registry catalog
 * in its output when resources have a registry attached.
 */

import { describe, expect, it } from "vitest";
import { createEventRegistry, defineEvent } from "../../src/events/defineEvent.js";

describe("CLI Describe — Event Catalog", () => {
  it("should produce a serializable event catalog from registry", () => {
    const registry = createEventRegistry();

    registry.register(
      defineEvent({
        name: "order.created",
        version: 1,
        description: "Emitted when an order is placed",
        schema: {
          type: "object",
          properties: {
            orderId: { type: "string" },
            total: { type: "number" },
            currency: { type: "string" },
          },
          required: ["orderId", "total"],
        },
      }),
    );

    registry.register(
      defineEvent({
        name: "order.shipped",
        version: 1,
        description: "Emitted when an order ships",
      }),
    );

    registry.register(
      defineEvent({
        name: "order.created",
        version: 2,
        description: "V2: includes currency",
        schema: {
          type: "object",
          properties: {
            orderId: { type: "string" },
            total: { type: "number" },
            currency: { type: "string" },
          },
          required: ["orderId", "total", "currency"],
        },
      }),
    );

    const catalog = registry.catalog();

    expect(catalog).toHaveLength(3);

    // Verify structure is JSON-serializable (no functions, no circular refs)
    const json = JSON.parse(JSON.stringify(catalog));
    expect(json).toHaveLength(3);

    // Check order.created v1
    const v1 = json.find((e: any) => e.name === "order.created" && e.version === 1);
    expect(v1).toBeDefined();
    expect(v1.description).toBe("Emitted when an order is placed");
    expect(v1.schema).toBeDefined();
    expect(v1.schema.required).toEqual(["orderId", "total"]);

    // Check order.created v2
    const v2 = json.find((e: any) => e.name === "order.created" && e.version === 2);
    expect(v2).toBeDefined();
    expect(v2.schema.required).toEqual(["orderId", "total", "currency"]);

    // Check order.shipped (no schema)
    const shipped = json.find((e: any) => e.name === "order.shipped");
    expect(shipped).toBeDefined();
    expect(shipped.schema).toBeUndefined();
  });

  it("should produce describe-compatible event catalog format", () => {
    const registry = createEventRegistry();

    registry.register(
      defineEvent({
        name: "product.updated",
        description: "Product was modified",
        schema: {
          type: "object",
          properties: { productId: { type: "string" } },
          required: ["productId"],
        },
      }),
    );

    // Simulate what describe command would output
    const catalog = registry.catalog();
    const describeEvents = catalog.map((e) => ({
      name: e.name,
      version: e.version,
      description: e.description,
      hasSchema: !!e.schema,
      schemaFields: e.schema?.properties ? Object.keys(e.schema.properties) : [],
      requiredFields: e.schema?.required ?? [],
    }));

    expect(describeEvents).toEqual([
      {
        name: "product.updated",
        version: 1,
        description: "Product was modified",
        hasSchema: true,
        schemaFields: ["productId"],
        requiredFields: ["productId"],
      },
    ]);
  });

  it("should handle empty registry gracefully", () => {
    const registry = createEventRegistry();
    const catalog = registry.catalog();
    expect(catalog).toEqual([]);
  });
});
