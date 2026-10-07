/**
 * FilterDialect — what the parser EMITS is swappable; what it READS is the shared grammar.
 *
 *   1. The default Mongo dialect emits arc's record syntax with the Filter IR's meaning.
 *   2. `NEUTRAL_DIALECT` emits the grammar's own operator names for a host that compiles them.
 *   3. A custom dialect receives the canonical clauses and owns the output shape.
 */
import type { FilterClause } from "@classytic/repo-core/query-parser";
import { describe, expect, it } from "vitest";
import type { FilterDialect } from "../../src/utils/filter-dialect.js";
import { MONGO_DIALECT, NEUTRAL_DIALECT } from "../../src/utils/filter-dialect.js";
import { ArcQueryParser } from "../../src/utils/queryParser.js";

describe("FilterDialect — Mongo default", () => {
  const parser = new ArcQueryParser();

  it("emits Mongo operator tokens, merged per field", () => {
    const { filters } = parser.parse({ price: { gte: "40", lte: "100" }, status: "active" });
    expect(filters).toEqual({ price: { $gte: 40, $lte: 100 }, status: "active" });
  });

  it("emits text operators as LITERAL, case-insensitive regexes", () => {
    expect(parser.parse({ name: { contains: "a.b" } }).filters).toEqual({
      name: { $regex: "a\\.b", $options: "i" },
    });
    expect(parser.parse({ name: { startsWith: "ab" } }).filters).toEqual({
      name: { $regex: "^ab", $options: "i" },
    });
  });

  it("emits the in operator", () => {
    expect(parser.parse({ tag: { in: "a,b,c" } }).filters).toEqual({
      tag: { $in: ["a", "b", "c"] },
    });
  });

  it("passing MONGO_DIALECT explicitly is identical to the default", () => {
    const explicit = new ArcQueryParser({ dialect: MONGO_DIALECT });
    expect(explicit.parse({ price: { gte: "40" } }).filters).toEqual({ price: { $gte: 40 } });
  });
});

describe("FilterDialect — retargeting", () => {
  it("NEUTRAL_DIALECT emits the grammar's own operator names", () => {
    const parser = new ArcQueryParser({ dialect: NEUTRAL_DIALECT });
    expect(parser.parse({ price: { gte: "40", lte: "100" } }).filters).toEqual({
      price: { gte: 40, lte: 100 },
    });
    expect(parser.parse({ name: { contains: "hoodie" } }).filters).toEqual({
      name: { contains: "hoodie" },
    });
  });

  it("a custom dialect receives the canonical clauses and owns the output", () => {
    const seen: FilterClause[][] = [];
    const sqlish: FilterDialect = {
      emit: (clauses) => {
        seen.push([...clauses]);
        return { where: clauses.map((c) => `${c.field} ${c.op}`).join(" AND ") };
      },
      tokens: [],
    };
    const parser = new ArcQueryParser({ dialect: sqlish });
    expect(parser.parse({ price: { gte: "40" }, status: "active" }).filters).toEqual({
      where: "price gte AND status eq",
    });
    expect(seen[0]).toEqual([
      { field: "price", op: "gte", value: 40 },
      { field: "status", op: "eq", value: "active" },
    ]);
  });

  it("the OpenAPI schema documents the grammar's operators, whatever the dialect", () => {
    const neutral = new ArcQueryParser({ dialect: NEUTRAL_DIALECT });
    const ops = (neutral.getQuerySchema().properties._filterOperators as { description: string })
      .description;
    expect(ops).toContain("gte: Greater than or equal");
    expect(ops).toContain("contains: Contains the text (literal, case-insensitive)");
  });
});
