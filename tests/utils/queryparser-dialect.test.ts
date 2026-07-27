/**
 * FilterDialect — proves the parser's Mongo operator emission is now a
 * swappable default, NOT hardcoded.
 *
 *   1. Backward-compat: the default parser (no dialect) emits the exact Mongo
 *      shape every prior arc version did — `$gte`, `$in`, `$options: 'i'`.
 *   2. Retarget: `NEUTRAL_DIALECT` emits un-prefixed tokens as a store-neutral
 *      AST, so a non-Mongo host retargets operators without writing a full
 *      QueryParserInterface.
 */
import { describe, expect, it } from "vitest";
import type { FilterDialect } from "../../src/utils/filter-dialect.js";
import { MONGO_DIALECT, NEUTRAL_DIALECT } from "../../src/utils/filter-dialect.js";
import { ArcQueryParser } from "../../src/utils/queryParser.js";

describe("FilterDialect — Mongo default (backward-compatible)", () => {
  const parser = new ArcQueryParser();

  it("emits Mongo operator tokens", () => {
    const { filters } = parser.parse({ price: { gte: "40", lte: "100" }, status: "active" });
    expect(filters).toEqual({ price: { $gte: 40, $lte: 100 }, status: "active" });
  });

  it("stamps $options: 'i' for case-insensitive contains/like", () => {
    const { filters } = parser.parse({ name: { contains: "hoodie" } });
    expect(filters).toEqual({ name: { $regex: "hoodie", $options: "i" } });
  });

  it("emits $in for the in operator", () => {
    const { filters } = parser.parse({ tag: { in: "a,b,c" } });
    expect(filters).toEqual({ tag: { $in: ["a", "b", "c"] } });
  });

  it("passing MONGO_DIALECT explicitly is identical to the default", () => {
    const explicit = new ArcQueryParser({ dialect: MONGO_DIALECT });
    expect(explicit.parse({ price: { gte: "40" } }).filters).toEqual({ price: { $gte: 40 } });
  });
});

describe("FilterDialect — retargeting", () => {
  it("NEUTRAL_DIALECT emits un-prefixed tokens + caseInsensitive flag", () => {
    const parser = new ArcQueryParser({ dialect: NEUTRAL_DIALECT });
    expect(parser.parse({ price: { gte: "40", lte: "100" } }).filters).toEqual({
      price: { gte: 40, lte: 100 },
    });
    // NEUTRAL maps contains → its own `contains` token (not Mongo's shared $regex).
    expect(parser.parse({ name: { contains: "hoodie" } }).filters).toEqual({
      name: { contains: "hoodie", caseInsensitive: true },
    });
  });

  it("a custom dialect controls the emitted vocabulary", () => {
    const sqlish: FilterDialect = {
      operators: { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", in: "IN" },
      caseInsensitiveModifier: () => ({}),
    };
    const parser = new ArcQueryParser({ dialect: sqlish });
    expect(parser.parse({ price: { gte: "40" } }).filters).toEqual({ price: { ">=": 40 } });
    // An operator object with NO tokens the dialect knows isn't a recognised
    // operator filter, so arc's pre-existing fallback treats it as a literal
    // equality value (dialect-independent behaviour) — not silently dropped.
    expect(parser.parse({ name: { regex: "x" } }).filters).toEqual({ name: { regex: "x" } });
  });

  it("the OpenAPI schema reflects the active dialect's tokens", () => {
    const neutral = new ArcQueryParser({ dialect: NEUTRAL_DIALECT });
    const schema = neutral.getQuerySchema();
    const ops = (schema.properties._filterOperators as { description: string }).description;
    expect(ops).toContain("gte → gte");
    expect(ops).not.toContain("gte → $gte");
  });
});
