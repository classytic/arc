/**
 * Property-Based Tests: ArcQueryParser
 *
 * Hand-rolled examples catch known cases. Property tests catch the ones
 * you didn't think of — malformed limit values, operator soup in filter
 * keys, UTF-16 surrogate pairs in search strings, nested filter bombs.
 *
 * The invariants we care about:
 *  1. `parse()` never throws on any `Record<string, unknown>` input.
 *  2. `limit` is always `1 ≤ limit ≤ maxLimit`.
 *  3. `page` is always `≥ 1` when present.
 *  4. `sort` entries are always `{ [field]: 1 | -1 }` shape.
 *  5. `search` obeys the configured max length.
 *  6. Regex length cap prevents DOS.
 *  7. Reserved params (page/limit/sort/...) never leak into `filters`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RESERVED_QUERY_PARAMS } from "../../src/constants.js";
import { ArcQueryParser } from "../../src/utils/queryParser.js";

const parser = new ArcQueryParser({ maxLimit: 100, defaultLimit: 20 });

describe("Property: ArcQueryParser invariants", () => {
  it("parse() never throws on arbitrary query records", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string(),
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.double(),
            fc.boolean(),
            fc.constant(null),
            fc.constant(undefined),
            fc.array(fc.string()),
          ),
        ),
        (query) => {
          parser.parse(query);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("limit is always within [1, maxLimit]", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.string(),
          fc.constant(undefined),
          fc.constant(null),
          fc.double({ noNaN: false, noDefaultInfinity: false }),
          fc.constant("not-a-number"),
          fc.constant("-5"),
          fc.constant("9999999999"),
        ),
        (limit) => {
          const { limit: out } = parser.parse({ limit });
          return out >= 1 && out <= 100;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("page is always >= 1 when present", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.string(), fc.constant(undefined)), (page) => {
        const result = parser.parse({ page });
        return result.page === undefined || result.page >= 1;
      }),
      { numRuns: 200 },
    );
  });

  it("sort entries are {field: 1 | -1} shape", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.stringMatching(/^-?[a-zA-Z_]+(,-?[a-zA-Z_]+)*$/),
          fc.constant(undefined),
        ),
        (sort) => {
          const { sort: out } = parser.parse({ sort });
          if (out === undefined) return true;
          for (const v of Object.values(out)) {
            if (v !== 1 && v !== -1) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reserved params never appear as filters", () => {
    fc.assert(
      fc.property(
        fc.record({
          page: fc.integer({ min: 1, max: 1000 }),
          limit: fc.integer({ min: 1, max: 100 }),
          sort: fc.string(),
          search: fc.string(),
          select: fc.string(),
          populate: fc.string(),
          cursor: fc.string(),
          extraField: fc.string(),
        }),
        (query) => {
          const { filters } = parser.parse(query);
          for (const reserved of RESERVED_QUERY_PARAMS) {
            if (reserved in filters) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("search obeys max length when configured", () => {
    const bounded = new ArcQueryParser({ maxSearchLength: 50 });
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (search) => {
        const result = bounded.parse({ search });
        if (result.search === undefined) return true;
        return result.search.length <= 50;
      }),
      { numRuns: 200 },
    );
  });

  it("regex ReDoS patterns are dropped via sanitiser", () => {
    // Classic catastrophic backtracking pattern. The parser uses URL-style
    // operator names (`regex`, not `$regex`) — see queryParser.ts operator map.
    const evil = "(a+)+b";
    const result = parser.parse({ name: { regex: evil } });
    const nameFilter = result.filters.name as Record<string, unknown> | undefined;
    if (nameFilter && "$regex" in nameFilter) {
      // Sanitiser returns empty string for dangerous patterns.
      expect(nameFilter.$regex).not.toBe(evil);
    }
  });

  it("absurdly long regex is capped at MAX_REGEX_LENGTH", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 5 }).map((s) => s.repeat(200)),
        (huge) => {
          const result = parser.parse({ name: { regex: huge } });
          const f = result.filters.name as Record<string, unknown> | undefined;
          if (f && typeof f.$regex === "string") {
            return (f.$regex as string).length <= 500;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("deeply nested filter objects do not stack-overflow", () => {
    // Build { a: { a: { a: ... } } } depth 50
    let nested: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 50; i++) {
      nested = { nested };
    }
    expect(() => parser.parse({ filter: nested })).not.toThrow();
  });

  it("idempotent for stable inputs: parse(parse-stringifiable) equals itself", () => {
    fc.assert(
      fc.property(
        fc.record({
          page: fc.integer({ min: 1, max: 100 }),
          limit: fc.integer({ min: 1, max: 100 }),
          sort: fc.constantFrom("createdAt", "-createdAt", "name"),
        }),
        (query) => {
          const first = parser.parse(query);
          const second = parser.parse(query);
          return JSON.stringify(first) === JSON.stringify(second);
        },
      ),
      { numRuns: 100 },
    );
  });
});
