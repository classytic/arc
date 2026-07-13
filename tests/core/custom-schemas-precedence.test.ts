/**
 * customSchemas × adapter-generated schema precedence (2.21 fix).
 *
 * A host `customSchemas.create.body` describes a COMPLETE wire contract —
 * often a legacy/public shape that a custom controller maps onto the kernel
 * model. It must REPLACE the adapter-generated body wholesale. The pre-2.21
 * per-op deepMerge UNIONED `required[]`, so the generated body's
 * model-required fields (e.g. server-derived `branch`) leaked into the
 * custom contract and 400'd every legacy-wire create. Dormant while
 * adapters had no schema generator; detonated when mongokit 3.21 turned
 * generation on by default — caught by the be-prod live smoke (28
 * production resources).
 *
 * The cross-part intent stays: parts the custom schema does NOT touch
 * (generated `params` when only `body` is customised) survive.
 */

import { describe, expect, it } from "vitest";
import { buildGeneratedCrudSchemas } from "../../src/core/defineResource/plugin.js";

const generatedOpenApi = {
  createBody: {
    type: "object",
    required: ["branch", "supplier", "items"],
    properties: {
      branch: { type: "string" },
      supplier: { type: "string" },
      items: { type: "array" },
    },
  },
  updateBody: {
    type: "object",
    required: ["branch"],
    properties: { branch: { type: "string" } },
  },
  params: {
    type: "object",
    properties: { id: { type: "string", pattern: "^[0-9a-fA-F]{24}$" } },
  },
};

describe("buildGeneratedCrudSchemas — customSchemas precedence", () => {
  it("a custom create.body REPLACES the generated body — no required[] union", () => {
    const customBody = {
      type: "object",
      required: ["invoiceNumber"],
      properties: { invoiceNumber: { type: "string" }, note: { type: "string" } },
    };
    const schemas = buildGeneratedCrudSchemas(generatedOpenApi, {
      create: { body: customBody },
    });

    const createBody = (schemas?.create as { body: Record<string, unknown> }).body;
    expect(createBody.required).toEqual(["invoiceNumber"]); // NOT unioned with branch/supplier/items
    expect((createBody.properties as Record<string, unknown>).branch).toBeUndefined();
  });

  it("generated parts the custom schema does not touch survive (body customised, params kept)", () => {
    const schemas = buildGeneratedCrudSchemas(generatedOpenApi, {
      update: { body: { type: "object", properties: { note: { type: "string" } } } },
    });
    const update = schemas?.update as { body: Record<string, unknown>; params?: unknown };
    expect(update.body.required).toBeUndefined(); // custom body replaced generated
    expect(update.params).toBeDefined(); // generated params survived
  });

  it("ops without customSchemas keep their generated schemas untouched", () => {
    const schemas = buildGeneratedCrudSchemas(generatedOpenApi, {
      create: { body: { type: "object" } },
    });
    const get = schemas?.get as { params: Record<string, unknown> };
    expect(get.params).toBeDefined();
  });

  it("customSchemas alone (no generated) still work — pre-3.21 shape", () => {
    const schemas = buildGeneratedCrudSchemas(undefined, {
      create: { body: { type: "object", required: ["name"] } },
    });
    const createBody = (schemas?.create as { body: Record<string, unknown> }).body;
    expect(createBody.required).toEqual(["name"]);
  });
});
