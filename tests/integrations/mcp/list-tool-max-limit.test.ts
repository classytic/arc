/**
 * The MCP list tool must advertise the RESOURCE's page cap.
 *
 * `PAGINATION_SHAPE` hardcoded `.max(100)` and the description "Items per page
 * (max 100)", making MCP a FOURTH independent cap alongside the query parser,
 * the repository's pagination engine and arc's resolver. On a resource
 * configured for 1000 the tool rejected `limit: 500` outright and TOLD the agent
 * the ceiling was 100 — so a model reading the schema was misinformed, not just
 * limited. Every other layer now defers to the resource's answer; this is the
 * last one that did not.
 */

import { describe, expect, it } from "vitest";
import { fieldRulesToZod } from "../../../src/integrations/mcp/fieldRulesToZod.js";

/** The `limit` entry's max, read off the built Zod shape. */
const limitMaxOf = (shape: Record<string, unknown>): number | undefined => {
  const def = (shape.limit as { _def?: unknown })?._def as
    | { innerType?: { _def?: { checks?: Array<{ kind?: string; value?: number }> } } }
    | undefined;
  const checks = def?.innerType?._def?.checks ?? [];
  return checks.find((c) => c.kind === "max")?.value;
};

const listShape = (maxLimit?: number) =>
  fieldRulesToZod(undefined, {
    mode: "list",
    ...(maxLimit === undefined ? {} : { maxLimit }),
  }) as Record<string, unknown>;

describe("MCP list tool — page cap", () => {
  it("accepts a page size the resource allows", () => {
    const shape = listShape(1000);
    expect(() => (shape.limit as { parse: (v: unknown) => unknown }).parse(500)).not.toThrow();
  });

  it("still refuses one beyond the resource's cap", () => {
    const shape = listShape(1000);
    expect(() => (shape.limit as { parse: (v: unknown) => unknown }).parse(5000)).toThrow();
  });

  it("DESCRIBES the resource's cap, so the agent is not misinformed", () => {
    const desc = (listShape(1000).limit as { description?: string }).description;
    expect(desc).toContain("1000");
    expect(desc).not.toContain("100)");
  });

  it("falls back to 100 when the resource declares no cap", () => {
    const shape = listShape(undefined);
    expect(limitMaxOf(shape) ?? 100).toBe(100);
    expect((shape.limit as { description?: string }).description).toContain("100");
  });

  it("honours a cap SMALLER than the old hardcoded default", () => {
    const shape = listShape(25);
    expect(() => (shape.limit as { parse: (v: unknown) => unknown }).parse(50)).toThrow();
    expect((shape.limit as { description?: string }).description).toContain("25");
  });
});
