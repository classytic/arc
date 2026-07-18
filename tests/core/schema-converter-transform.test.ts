/**
 * Regression: Zod schemas carrying `.transform()` / `.refine()` (Zod-only
 * features with no JSON Schema equivalent) must NOT make the whole schema
 * collapse to a permissive `{ type: 'object' }` + a loud warning on the
 * doc-generation path.
 *
 * Zod v4's `z.toJSONSchema()` defaults to `unrepresentable: 'throw'`, which
 * throws the moment it hits a transform — so a single transformed field would
 * previously nuke the entire schema. Better-auth's endpoint schemas use
 * transforms internally, so every arc+better-auth host saw one warning per
 * unconvertible auth schema after the Zod 4.4 bump.
 *
 * The fix: non-strict (`warn`) mode passes `unrepresentable: 'any'` so an
 * unrepresentable node emits `{}` for THAT field while the rest of the schema
 * survives. Strict `throw` mode (action-route validation) keeps `'throw'`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ensureSchemaConverter, toJsonSchema } from "../../src/utils/schemaConverter.js";

describe("toJsonSchema — Zod transforms (unrepresentable handling)", () => {
  beforeAll(async () => {
    await ensureSchemaConverter();
  });

  const withTransform = z.object({
    id: z.string(),
    // Zod-only feature with no JSON Schema equivalent.
    email: z.string().transform((s) => s.trim().toLowerCase()),
  });

  it("warn mode: converts partially — representable fields survive, no permissive collapse", () => {
    const out = toJsonSchema(withTransform); // default 'warn'
    expect(out).toBeDefined();
    expect(out?.type).toBe("object");
    const props = (out?.properties ?? {}) as Record<string, unknown>;
    // Did NOT collapse to a bare `{ type: 'object' }` fallback — `id` is preserved.
    expect(props.id).toBeDefined();
    expect((props.id as { type?: string }).type).toBe("string");
  });

  it("throw mode keeps strictness: an unrepresentable transform is a loud error", () => {
    expect(() => toJsonSchema(withTransform, "draft-7", "throw")).toThrow(/arc\/schema/);
  });

  it("plain JSON Schema still passes through untouched", () => {
    const json = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    expect(toJsonSchema(json)).toEqual(json);
  });
});
