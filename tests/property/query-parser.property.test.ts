/**
 * Property-Based Tests: ArcQueryParser
 *
 * Hand-rolled examples catch known cases. Property tests catch the ones
 * you didn't think of — malformed limit values, operator soup in filter
 * keys, UTF-16 surrogate pairs in search strings, nested filter bombs.
 *
 * The invariants we care about:
 *  1. `parse()` throws nothing but a `ValidationError` on any `Record<string, unknown>` input.
 *     Invalid input is REFUSED (400); invariants 2-7 hold for every parse that succeeds.
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
import { ValidationError } from "../../src/utils/errors.js";
import { MONGO_DIALECT } from "../../src/utils/filter-dialect.js";
import { ArcQueryParser } from "../../src/utils/queryParser.js";

const parser = new ArcQueryParser({ maxLimit: 100, defaultLimit: 20 });

/** The parse, or `undefined` for a 400 refusal. Any other throw is a bug and propagates. */
function parseOrRefuse(target: ArcQueryParser, query: Record<string, unknown>) {
  try {
    return target.parse(query);
  } catch (err) {
    if (err instanceof ValidationError) return undefined;
    throw err;
  }
}

describe("Property: ArcQueryParser invariants", () => {
  it("parse() never throws on arbitrary query records — except a ValidationError (400)", () => {
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
          // The filter grammar is closed: a `$` / `[` key outside it is refused
          // with a 400 by design. Anything else escaping parse() is a bug.
          try {
            parser.parse(query);
          } catch (err) {
            if (!(err instanceof ValidationError)) throw err;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a successful parse carries no client `$`-key — only the dialect's own operators", () => {
    // The invariant the closed filter grammar exists for: `$where`, `$expr`,
    // a raw `$ne` smuggled in a nested object — none reach the repository.
    const emitted = new Set(MONGO_DIALECT.tokens);
    const offending = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      for (const [key, inner] of Object.entries(value)) {
        if (key.startsWith("$") && !emitted.has(key)) return key;
        const nested = offending(inner);
        if (nested) return nested;
      }
      return undefined;
    };
    const key = fc.constantFrom(
      "price",
      "status",
      "name",
      "$where",
      "$expr",
      "$ne",
      "$gt",
      "gte",
      "in",
      "$regex",
      "price[gte]",
      "status[$ne]",
    );
    fc.assert(
      fc.property(
        fc.object({
          key,
          maxDepth: 3,
          values: [fc.string(), fc.integer(), fc.boolean(), fc.constant(null)],
        }),
        (query) => {
          let parsed: ReturnType<typeof parser.parse>;
          try {
            parsed = parser.parse(query);
          } catch (err) {
            if (err instanceof ValidationError) return true;
            throw err;
          }
          return offending(parsed.filters) === undefined;
        },
      ),
      { numRuns: 300 },
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
          const out = parseOrRefuse(parser, { limit })?.limit;
          return out === undefined || (out >= 1 && out <= 100);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("page is always >= 1 when present", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.string(), fc.constant(undefined)), (page) => {
        const page_ = parseOrRefuse(parser, { page })?.page;
        return page_ === undefined || page_ >= 1;
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
          const out = parseOrRefuse(parser, { sort })?.sort;
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
          const filters = parseOrRefuse(parser, query)?.filters ?? {};
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
        const result = parseOrRefuse(bounded, { search });
        return result?.search === undefined || result.search.length <= 50;
      }),
      { numRuns: 200 },
    );
  });

  it("a ReDoS-shaped regex is refused — never run, never rewritten", () => {
    expect(() => parser.parse({ name: { regex: "(a+)+b" } })).toThrow(ValidationError);
  });

  it("absurdly long regex is capped at MAX_REGEX_LENGTH", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 5 }).map((s) => s.repeat(200)),
        (huge) => {
          const result = parseOrRefuse(parser, { name: { regex: huge } });
          const f = result?.filters.name as Record<string, unknown> | undefined;
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
    // Refused with a 400 before recursing — never a stack overflow.
    expect(() => parseOrRefuse(parser, { filter: nested })).not.toThrow();
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
