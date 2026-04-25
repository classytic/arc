/**
 * Schema-field type widening (2.11.1).
 *
 * `ActionDefinition.schema` and `EventDefinition.schema` were typed
 * `Record<string, unknown>`. Zod's `ZodObject<...>` carries no string
 * index signature, so every action/event using a Zod schema needed:
 *
 *   schema: dispatchActionSchema as unknown as Record<string, unknown>,
 *
 * Sister slot `RouteDefinition.schema.body` was already `unknown` —
 * inconsistent. After 2.11.1, all three slots accept Zod, JSON Schema,
 * or any `unknown` value without a cast. Runtime feature-detects
 * via `convertRouteSchema` / `toJsonSchema`.
 *
 * If this file fails to compile, the widening regressed.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ActionDefinition, EventDefinition, RouteDefinition } from "../../src/types/index.js";

// ============================================================================
// Type-level: Zod schemas assign without a cast
// ============================================================================

describe("ActionDefinition.schema accepts Zod, JSON Schema, and plain objects without cast", () => {
  it("Zod ZodObject assigns directly", () => {
    const dispatchSchema = z.object({
      reason: z.string().min(1),
      forceClose: z.boolean().optional(),
    });

    // The line below would fail to compile before 2.11.1 because the slot
    // was typed `Record<string, unknown>` and ZodObject lacks a string
    // index signature.
    const def: ActionDefinition = {
      handler: async () => undefined,
      schema: dispatchSchema,
    };
    expect(def.schema).toBe(dispatchSchema);
  });

  it("plain JSON Schema still works (no behavior change)", () => {
    const def: ActionDefinition = {
      handler: async () => undefined,
      schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    };
    expect(def.schema).toBeDefined();
  });

  it("legacy field-map shape still works", () => {
    const def: ActionDefinition = {
      handler: async () => undefined,
      schema: { reason: { type: "string" }, count: { type: "number" } },
    };
    expect(def.schema).toBeDefined();
  });
});

describe("EventDefinition.schema accepts Zod without cast", () => {
  it("Zod ZodObject assigns directly", () => {
    const orderPlacedSchema = z.object({
      orderId: z.string(),
      total: z.number().positive(),
    });

    const def: EventDefinition = {
      name: "order.placed",
      schema: orderPlacedSchema,
    };
    expect(def.schema).toBe(orderPlacedSchema);
  });

  it("JSON Schema still works", () => {
    const def: EventDefinition = {
      name: "order.placed",
      schema: { type: "object", properties: { orderId: { type: "string" } } },
    };
    expect(def.schema).toBeDefined();
  });
});

describe("RouteDefinition.schema slots remain Zod-friendly (sister convention)", () => {
  it("RouteDefinition.schema.body accepts a Zod schema", () => {
    const bodySchema = z.object({ name: z.string(), price: z.number() });

    const def: RouteDefinition = {
      method: "POST",
      path: "/products",
      handler: "create",
      schema: { body: bodySchema },
    };
    expect((def.schema as { body: unknown }).body).toBe(bodySchema);
  });
});

// ============================================================================
// Type-level assertion — assignability is locked at compile time
// ============================================================================

type AssertAssignable<T, U> = T extends U ? true : false;

// `ActionDefinition.schema` accepts `unknown`, which means any value (Zod
// schema, JSON Schema, plain object, primitive) satisfies it. That's the
// intended widening — runtime guards do the type check.
type _ActionSchemaAcceptsUnknown = AssertAssignable<unknown, ActionDefinition["schema"]>;
const _action: _ActionSchemaAcceptsUnknown = true;
void _action;

type _EventSchemaAcceptsUnknown = AssertAssignable<unknown, EventDefinition["schema"]>;
const _event: _EventSchemaAcceptsUnknown = true;
void _event;
