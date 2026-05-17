/**
 * Tests for `defineAction()` — typed action data via Zod schema inference (2.16).
 *
 * Pre-2.16 every action handler received `data: Record<string, unknown>`
 * and hosts hand-cast it to a domain interface. The OpenAI-team report
 * asked for inference from the declared schema — write the schema once,
 * the handler's `data` lands typed.
 *
 * Contract this file locks in:
 *  - `defineAction({ schema: z.object({...}), handler })` produces a
 *    valid `ActionDefinition` arc consumes.
 *  - The runtime contract is identical to a bare object — same schema
 *    drives AJV body validation, same handler gets called.
 *  - At the type level, the handler's `data` parameter is inferred as
 *    `z.infer<typeof schema>` (verified at compile time via a typed
 *    handler that reads `data.<field>` without a cast).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "../../src/core/defineAction.js";
import { allowPublic } from "../../src/permissions/index.js";

describe("defineAction — runtime shape", () => {
  it("returns an ActionDefinition arc can consume", () => {
    const action = defineAction({
      schema: z.object({ stageId: z.string() }),
      permissions: allowPublic(),
      description: "Move a deal to a different stage",
      handler: async (id, data) => ({ id, stageId: data.stageId }),
    });

    // Same shape arc's existing `actions: { moveToStage: { ... } }` form
    // produces — handler / permissions / schema / description carried
    // through verbatim. Defaults the unused fields cleanly.
    expect(typeof action.handler).toBe("function");
    expect(action.permissions).toBeDefined();
    expect(action.description).toBe("Move a deal to a different stage");
    expect(action.schema).toBeDefined();
  });

  it("threads `id: false` (resource-root action) through unchanged", () => {
    const action = defineAction({
      schema: z.object({ brief: z.string() }),
      permissions: allowPublic(),
      id: false,
      handler: async (_id, data) => ({ proposed: data.brief }),
    });
    expect(action.id).toBe(false);
  });

  it("works without a schema — data is the untyped fallback", () => {
    // No-schema actions still compile through defineAction; data is
    // typed `Record<string, unknown>` (the default for the generic).
    const action = defineAction({
      permissions: allowPublic(),
      handler: async (id, data) => ({ id, raw: data }),
    });
    expect(action.schema).toBeUndefined();
    expect(typeof action.handler).toBe("function");
  });

  it("the handler actually runs with the declared shape", async () => {
    // End-to-end: declare schema, invoke handler with conforming data,
    // assert it reads the typed fields. This is the user-facing contract
    // beyond just "returns the right object".
    const action = defineAction({
      schema: z.object({
        stageId: z.string(),
        probability: z.number().optional(),
      }),
      permissions: allowPublic(),
      handler: async (id, data) => {
        // `data.stageId` and `data.probability` should both typecheck
        // without `(data as { ... })` casts. The compile-time guarantee
        // is the whole point — runtime just confirms parity.
        return { id, stage: data.stageId, prob: data.probability ?? 0 };
      },
    });

    const result = await action.handler(
      "deal-1",
      { stageId: "qualified", probability: 0.4 },
      // biome-ignore lint/suspicious/noExplicitAny: req is irrelevant for this assertion
      {} as any,
    );
    expect(result).toEqual({ id: "deal-1", stage: "qualified", prob: 0.4 });
  });
});

// ============================================================================
// Compile-time type assertion — these lines wouldn't compile pre-2.16
// ============================================================================

describe("defineAction — compile-time type inference", () => {
  it("infers handler's `data` from the declared schema", () => {
    // The fact this file typechecks (no `as any`, no `as { stageId: string }`)
    // is the proof. The runtime assertion is just a sanity anchor.
    const action = defineAction({
      schema: z.object({
        stageId: z.string(),
        probability: z.number().min(0).max(1).optional(),
      }),
      permissions: allowPublic(),
      handler: async (_id, data) => {
        // If TS infers data as `Record<string, unknown>`, `data.stageId`
        // is `unknown` and `.length` would fail. The fact this works
        // is the inference contract.
        const stageLen: number = data.stageId.length;
        const prob: number = data.probability ?? 0;
        return { stageLen, prob };
      },
    });
    expect(typeof action.handler).toBe("function");
  });
});
