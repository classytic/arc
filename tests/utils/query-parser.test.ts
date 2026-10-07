/**
 * ArcQueryParser Unit Tests
 *
 * Comprehensive tests for Arc's built-in query parser covering:
 * - Pagination (page, limit, cursor)
 * - Sorting (multi-field, direction)
 * - Filtering (operators, bracket notation, qs objects)
 * - Field selection (include/exclude)
 * - Search (truncation)
 * - Value coercion (string→number, boolean, null)
 * - Security (regex sanitization, field name validation, ReDoS protection)
 */

import { describe, expect, it } from "vitest";
import { ArcQueryParser, createQueryParser } from "../../src/utils/queryParser.js";

describe("ArcQueryParser", () => {
  const parser = new ArcQueryParser();

  // ============================================================================
  // Pagination
  // ============================================================================

  describe("Pagination", () => {
    it("should use default page and limit when not provided", () => {
      const result = parser.parse({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it("should parse page and limit from query", () => {
      const result = parser.parse({ page: "2", limit: "50" });
      expect(result.page).toBe(2);
      expect(result.limit).toBe(50);
    });

    it("refuses a page or limit below 1 — never silently clamped up", () => {
      expect(() => parser.parse({ page: "0" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
      expect(() => parser.parse({ limit: "0" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("should cap limit at maxLimit (default 1000)", () => {
      const result = parser.parse({ limit: "5000" });
      expect(result.limit).toBe(1000);
    });

    it("should respect custom maxLimit", () => {
      const customParser = new ArcQueryParser({ maxLimit: 50 });
      const result = customParser.parse({ limit: "100" });
      expect(result.limit).toBe(50);
    });

    it("should respect custom defaultLimit", () => {
      const customParser = new ArcQueryParser({ defaultLimit: 10 });
      const result = customParser.parse({});
      expect(result.limit).toBe(10);
    });

    it("refuses a non-numeric page or limit — never a silent default", () => {
      expect(() => parser.parse({ page: "abc" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
      expect(() => parser.parse({ limit: "xyz" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("should handle null/undefined query", () => {
      expect(parser.parse(null).page).toBe(1);
      expect(parser.parse(undefined).page).toBe(1);
    });
  });

  // ============================================================================
  // Cursor/Keyset Pagination
  // ============================================================================

  describe("Cursor Pagination", () => {
    it("should parse after parameter", () => {
      const result = parser.parse({ after: "cursor_abc123" });
      expect(result.after).toBe("cursor_abc123");
      expect(result.page).toBeUndefined(); // page is undefined when cursor is set
    });

    it("should parse cursor alias", () => {
      const result = parser.parse({ cursor: "cursor_xyz" });
      expect(result.after).toBe("cursor_xyz");
    });

    it("should prefer after over cursor", () => {
      const result = parser.parse({ after: "after_val", cursor: "cursor_val" });
      expect(result.after).toBe("after_val");
    });

    it("should ignore empty after value", () => {
      const result = parser.parse({ after: "" });
      expect(result.after).toBeUndefined();
      expect(result.page).toBe(1);
    });
  });

  // ============================================================================
  // Sorting
  // ============================================================================

  describe("Sorting", () => {
    it("should parse ascending sort", () => {
      const result = parser.parse({ sort: "name" });
      expect(result.sort).toEqual({ name: 1 });
    });

    it("should parse descending sort with - prefix", () => {
      const result = parser.parse({ sort: "-createdAt" });
      expect(result.sort).toEqual({ createdAt: -1 });
    });

    it("should parse multi-field sort", () => {
      const result = parser.parse({ sort: "-price,name,-createdAt" });
      expect(result.sort).toEqual({ price: -1, name: 1, createdAt: -1 });
    });

    it("should skip empty sort fields", () => {
      const result = parser.parse({ sort: "name,,price" });
      expect(result.sort).toEqual({ name: 1, price: 1 });
    });

    it("should return undefined for empty sort", () => {
      expect(parser.parse({ sort: "" }).sort).toBeUndefined();
      expect(parser.parse({}).sort).toBeUndefined();
    });

    it("refuses an invalid sort field — a malformed token is never quietly skipped", () => {
      expect(() => parser.parse({ sort: "$dangerous,name" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("should allow dot notation in sort (nested fields)", () => {
      const result = parser.parse({ sort: "-address.city,name" });
      expect(result.sort).toEqual({ "address.city": -1, name: 1 });
    });

    it("refuses sort fields with special characters", () => {
      expect(() => parser.parse({ sort: "name;DROP TABLE" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });
  });

  // ============================================================================
  // Field Selection
  // ============================================================================

  describe("Field Selection", () => {
    it("should parse inclusion select", () => {
      const result = parser.parse({ select: "name,email,age" });
      expect(result.select).toEqual({ name: 1, email: 1, age: 1 });
    });

    it("should parse exclusion select with - prefix", () => {
      const result = parser.parse({ select: "-password,-secret" });
      expect(result.select).toEqual({ password: 0, secret: 0 });
    });

    it("should handle mixed inclusion and exclusion", () => {
      const result = parser.parse({ select: "name,-password" });
      expect(result.select).toEqual({ name: 1, password: 0 });
    });

    it("should allow dot notation fields", () => {
      const result = parser.parse({ select: "address.city,address.zip" });
      expect(result.select).toEqual({ "address.city": 1, "address.zip": 1 });
    });

    it("should return undefined for empty select", () => {
      expect(parser.parse({ select: "" }).select).toBeUndefined();
      expect(parser.parse({}).select).toBeUndefined();
    });

    it("refuses an invalid field name in select", () => {
      expect(() => parser.parse({ select: "name,$invalid" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });
  });

  // ============================================================================
  // Search
  // ============================================================================

  describe("Search", () => {
    it("should parse search parameter", () => {
      const result = parser.parse({ search: "hello world" });
      expect(result.search).toBe("hello world");
    });

    it("should trim search value", () => {
      const result = parser.parse({ search: "  hello  " });
      expect(result.search).toBe("hello");
    });

    it("should return undefined for empty search", () => {
      expect(parser.parse({ search: "" }).search).toBeUndefined();
      expect(parser.parse({ search: "   " }).search).toBeUndefined();
    });

    it("refuses a search longer than maxSearchLength — a cut term matches rows nobody asked for", () => {
      expect(() => parser.parse({ search: "a".repeat(300) })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
      expect(parser.parse({ search: "a".repeat(200) }).search).toHaveLength(200);
    });

    it("respects a custom maxSearchLength", () => {
      const customParser = new ArcQueryParser({ maxSearchLength: 50 });
      expect(() => customParser.parse({ search: "a".repeat(100) })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
      expect(customParser.parse({ search: "a".repeat(50) }).search).toHaveLength(50);
    });
  });

  // ============================================================================
  // Populate
  // ============================================================================

  describe("Populate", () => {
    it("should parse simple populate string", () => {
      const result = parser.parse({ populate: "author,category" });
      expect(result.populate).toBe("author,category");
    });

    it("should return undefined for empty populate", () => {
      expect(parser.parse({ populate: "" }).populate).toBeUndefined();
    });

    it("ANDs equality and a range on one field, in either key order", () => {
      expect(parser.parse({ price: "5", "price[gte]": "1" }).filters).toEqual({
        price: { $eq: 5, $gte: 1 },
      });
      expect(parser.parse({ "price[gte]": "1", price: "5" }).filters).toEqual({
        price: { $gte: 1, $eq: 5 },
      });
      expect(parser.parse({ "price[lte]": "9", price: { gte: "1" } }).filters).toEqual({
        price: { $lte: 9, $gte: 1 },
      });
    });

    it("keeps a bracket-form populate match of field equality", () => {
      const result = parser.parse({ populate: { customer: { match: { status: "active" } } } });
      expect(result.populateOptions).toEqual([{ path: "customer", match: { status: "active" } }]);
    });

    it("refuses an operator, a nested object, or a JSON-string match", () => {
      for (const match of [
        { $where: "sleep(1)" },
        { status: { $ne: "x" } },
        '{"status":"active"}',
      ]) {
        expect(() => parser.parse({ populate: { customer: { match } } })).toThrow(
          /Populate match on "customer"/,
        );
      }
    });
  });

  // ============================================================================
  // Filtering — Direct Equality
  // ============================================================================

  describe("Filtering — Equality", () => {
    it("should parse direct equality filter", () => {
      const result = parser.parse({ status: "active" });
      expect(result.filters).toEqual({ status: "active" });
    });

    it("should parse multiple equality filters", () => {
      const result = parser.parse({ status: "active", type: "premium" });
      expect(result.filters).toEqual({ status: "active", type: "premium" });
    });

    it("should coerce numeric values", () => {
      const result = parser.parse({ age: "25" });
      expect(result.filters).toEqual({ age: 25 });
    });

    it("should coerce boolean values", () => {
      const result = parser.parse({ isActive: "true", isDeleted: "false" });
      expect(result.filters).toEqual({ isActive: true, isDeleted: false });
    });

    it("should coerce null values", () => {
      const result = parser.parse({ deletedAt: "null" });
      expect(result.filters).toEqual({ deletedAt: null });
    });

    it("should not coerce strings that look like numbers with whitespace", () => {
      const result = parser.parse({ code: "  " });
      // Whitespace-only strings: Number('  ') is 0 but trim is '', so coercion returns ''
      expect(result.filters).toEqual({ code: "  " });
    });

    it("should skip reserved keys", () => {
      const result = parser.parse({
        page: "1",
        limit: "20",
        sort: "-name",
        populate: "author",
        search: "test",
        select: "name",
        after: "abc",
        cursor: "xyz",
        lean: "true",
        _policyFilters: "{}",
        status: "active", // Only this should be in filters
      });
      expect(result.filters).toEqual({ status: "active" });
    });

    it("refuses a $-prefixed key outright — an operator attempt is never dropped quietly", () => {
      expect(() => parser.parse({ $inject: "malicious", valid_field: "good" })).toThrow(
        /"\$inject": `\$` operators are not part of the query grammar/,
      );
    });

    it("refuses a malformed key even when not strict — only allowlist misses are dropped", () => {
      expect(() => parser.parse({ "0startWithDigit": "bad", valid_field: "good" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
      const lenient = new ArcQueryParser({
        strictFilterFields: false,
        allowedFilterFields: ["valid_field"],
      });
      expect(lenient.parse({ secret: "x", valid_field: "good" }).filters).toEqual({
        valid_field: "good",
      });
    });
  });

  // ============================================================================
  // Filtering — Operators via qs-parsed Objects
  // ============================================================================
  // NOTE: In Fastify with qs parser, ?price[gte]=100 arrives as { price: { gte: '100' } }
  // ArcQueryParser handles the qs-parsed object format — NOT raw bracket notation keys.

  describe("Filtering — Operator Objects (qs-parsed)", () => {
    it("should parse gte operator", () => {
      const result = parser.parse({ price: { gte: "100" } });
      expect(result.filters).toEqual({ price: { $gte: 100 } });
    });

    it("should parse lte operator", () => {
      const result = parser.parse({ price: { lte: "500" } });
      expect(result.filters).toEqual({ price: { $lte: 500 } });
    });

    it("should parse multiple operators on same field", () => {
      const result = parser.parse({ price: { gte: "100", lte: "500" } });
      expect(result.filters).toEqual({ price: { $gte: 100, $lte: 500 } });
    });

    it("should parse ne operator", () => {
      const result = parser.parse({ status: { ne: "deleted" } });
      // `ne` never matches a null or missing value (SQL three-valued logic, the IR's rule).
      expect(result.filters).toEqual({ status: { $nin: ["deleted", null] } });
    });

    it("should parse eq operator", () => {
      const result = parser.parse({ status: { eq: "active" } });
      // `[eq]` is plain equality.
      expect(result.filters).toEqual({ status: "active" });
    });

    it("should parse gt and lt operators", () => {
      const result = parser.parse({ age: { gt: "18", lt: "65" } });
      expect(result.filters).toEqual({ age: { $gt: 18, $lt: 65 } });
    });

    it("should parse exists operator (true)", () => {
      const result = parser.parse({ avatar: { exists: "true" } });
      // `exists` means has a non-null value (the IR's rule, identical on SQL backends).
      expect(result.filters).toEqual({ avatar: { $ne: null } });
    });

    it("should parse exists operator (false)", () => {
      const result = parser.parse({ avatar: { exists: "false" } });
      expect(result.filters).toEqual({ avatar: null });
    });

    it("should parse exists with numeric 1/0", () => {
      const resultTrue = parser.parse({ avatar: { exists: "1" } });
      expect(resultTrue.filters).toEqual({ avatar: { $ne: null } });

      const resultFalse = parser.parse({ avatar: { exists: "0" } });
      expect(resultFalse.filters).toEqual({ avatar: null });
    });
  });

  // ============================================================================
  // Filtering — qs-parsed Object Format
  // ============================================================================

  describe("Filtering — qs Object Format", () => {
    it('should handle qs-parsed operator objects: { price: { gte: "40", lte: "100" } }', () => {
      // When qs parses ?price[gte]=40&price[lte]=100, it produces:
      const result = parser.parse({ price: { gte: "40", lte: "100" } });
      expect(result.filters).toEqual({ price: { $gte: 40, $lte: 100 } });
    });

    it("should handle single qs-parsed operator", () => {
      const result = parser.parse({ age: { gt: "18" } });
      expect(result.filters).toEqual({ age: { $gt: 18 } });
    });

    it("refuses a non-operator nested key and points at the dot path", () => {
      expect(() => parser.parse({ metadata: { color: "red" } })).toThrow(
        /unknown operator "color".*a nested field is a dot path: metadata\.color/,
      );
      expect(parser.parse({ "metadata.color": "red" }).filters).toEqual({
        "metadata.color": "red",
      });
    });

    it("refuses a mixed operator/non-operator object — nothing is passed through raw", () => {
      expect(() => parser.parse({ price: { gte: "10", notAnOp: "val" } })).toThrow(/"notAnOp"/);
    });

    it("refuses a $ operator smuggled in either bracket form", () => {
      expect(() => parser.parse({ price: { $ne: "x" } })).toThrow(/price\[\$ne\]/);
      expect(() => parser.parse({ status: { $where: "1" } })).toThrow(/status\[\$where\]/);
      expect(() => parser.parse({ "price[$ne]": "x" })).toThrow(/not part of the query grammar/);
    });
  });

  // ============================================================================
  // Filtering — Array Operators (in/nin)
  // ============================================================================

  describe("Filtering — in/nin operators", () => {
    it("should parse in operator with comma-separated string", () => {
      const result = parser.parse({ status: { in: "active,pending,review" } });
      expect(result.filters).toEqual({ status: { $in: ["active", "pending", "review"] } });
    });

    it("should parse in operator with array value", () => {
      const result = parser.parse({ status: { in: ["active", "pending"] } });
      expect(result.filters).toEqual({ status: { $in: ["active", "pending"] } });
    });

    it("should coerce numeric values in array operators", () => {
      const result = parser.parse({ priority: { in: "1,2,3" } });
      expect(result.filters).toEqual({ priority: { $in: [1, 2, 3] } });
    });

    it("should parse nin operator", () => {
      const result = parser.parse({ status: { nin: "deleted,archived" } });
      expect(result.filters).toEqual({ status: { $nin: ["deleted", "archived", null] } });
    });

    it("should wrap single value in array", () => {
      const result = parser.parse({ status: { in: "active" } });
      expect(result.filters).toEqual({ status: { $in: ["active"] } });
    });
  });

  // ============================================================================
  // Filtering — Bracket Envelope (?filter[foo]=X / ?filter[price][gte]=40)
  // ============================================================================

  describe("Filtering — Bracket envelope form (?filter[...])", () => {
    it("accepts simple bracket-wrapped equality filters", () => {
      // URL: ?filter[status]=active — qs parses to { filter: { status: 'active' } }
      const result = parser.parse({ filter: { status: "active" } });
      expect(result.filters).toEqual({ status: "active" });
    });

    it("accepts bracket-wrapped operator filters", () => {
      // URL: ?filter[price][gte]=100&filter[price][lte]=500
      const result = parser.parse({
        filter: { price: { gte: "100", lte: "500" } },
      });
      expect(result.filters).toEqual({ price: { $gte: 100, $lte: 500 } });
    });

    it("accepts a mix of envelope and bare top-level filters", () => {
      const result = parser.parse({
        filter: { status: "active" },
        priority: "high",
      });
      expect(result.filters).toEqual({ status: "active", priority: "high" });
    });

    it("an envelope value and a bare value for one field are a union, never one dropped", () => {
      const result = parser.parse({ filter: { status: "active" }, status: "closed" });
      expect(result.filters).toEqual({ status: { $in: ["active", "closed"] } });
    });

    it("refuses a `filter` that is not an envelope object", () => {
      expect(() => parser.parse({ filter: "bogus" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("respects allowedFilterFields whitelist through the envelope path", () => {
      const whitelisted = new ArcQueryParser({ allowedFilterFields: ["status"] });
      const result = whitelisted.parse({
        filter: { status: "active", secret: "leak" },
      });
      expect(result.filters).toEqual({ status: "active" });
    });
  });

  // ============================================================================
  // Filtering — Regex Operators (like/contains/regex)
  // ============================================================================

  describe("Filtering — Regex operators (like/contains/regex)", () => {
    it("should parse like operator as case-insensitive regex (v2.10.9)", () => {
      // `like` is documented as "Pattern match (case-insensitive)" — the
      // parser emits `$options: 'i'` so mongokit / mongoose honor that.
      // Regression guard for the silently-case-sensitive-fuzzy-search bug
      // surfaced in be-prod's supplier search (`name[contains]=bigboss`
      // missing "Bigboss Factory").
      const result = parser.parse({ name: { like: "john" } });
      expect(result.filters).toEqual({ name: { $regex: "john", $options: "i" } });
    });

    it("should parse contains operator as case-insensitive regex (v2.10.9)", () => {
      // Same rationale as `like` — docs advertise "Contains substring
      // (case-insensitive)", parser now implements that promise.
      const result = parser.parse({ title: { contains: "hello" } });
      expect(result.filters).toEqual({ title: { $regex: "hello", $options: "i" } });
    });

    it("should parse regex operator WITHOUT forcing case-insensitive (v2.10.9)", () => {
      // Unlike `contains` / `like`, the `regex` operator hands raw control
      // to the caller — they supply their own pattern and are expected to
      // include `(?i)` / `$options` if they want case-insensitivity. Arc
      // must not silently add `$options: 'i'` here or case-sensitive
      // regex queries would silently become case-insensitive.
      const result = parser.parse({ email: { regex: "^test@" } });
      expect(result.filters).toEqual({ email: { $regex: "^test@" } });
    });

    // An unsafe or over-long regex is REFUSED — never truncated or escaped, both of which would
    // silently change what the caller asked for.
    it("refuses a regex longer than maxRegexLength", () => {
      expect(() => parser.parse({ name: { regex: "a".repeat(600) } })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("refuses a ReDoS-shaped regex", () => {
      expect(() => parser.parse({ name: { regex: "(a+)+" } })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("refuses an invalid regex", () => {
      expect(() => parser.parse({ name: { regex: "a*+b" } })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("respects a custom maxRegexLength", () => {
      const customParser = new ArcQueryParser({ maxRegexLength: 20 });
      expect(() => customParser.parse({ name: { regex: "a".repeat(50) } })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
      expect(
        (customParser.parse({ name: { regex: "a".repeat(20) } }).filters as any).name.$regex,
      ).toBe("a".repeat(20));
    });

    it("should allow safe regex patterns unchanged", () => {
      const result = parser.parse({ name: { regex: "^John" } });
      expect((result.filters as any).name.$regex).toBe("^John");
    });
  });

  // ============================================================================
  // Security — Field Name Validation
  // ============================================================================

  describe("Security — Field Name Validation", () => {
    it("should reject fields starting with $", () => {
      expect(() => parser.parse({ $where: "1" })).toThrow(/not part of the query grammar/);
    });

    it("should reject fields starting with digits", () => {
      expect(() => parser.parse({ "0field": "val" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("should allow underscore-prefixed fields", () => {
      const result = parser.parse({ _type: "internal" });
      expect(result.filters).toEqual({ _type: "internal" });
    });

    it("should allow dot notation for nested fields", () => {
      const result = parser.parse({ "address.city": "NYC" });
      expect(result.filters).toEqual({ "address.city": "NYC" });
    });

    it("should reject fields with spaces", () => {
      expect(() => parser.parse({ "bad field": "val" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });

    it("should reject fields with semicolons", () => {
      expect(() => parser.parse({ "field;rm": "val" })).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      );
    });
  });

  // ============================================================================
  // Value Coercion
  // ============================================================================

  describe("Value Coercion", () => {
    it('should coerce "true" to boolean true', () => {
      const result = parser.parse({ active: "true" });
      expect(result.filters).toEqual({ active: true });
    });

    it('should coerce "false" to boolean false', () => {
      const result = parser.parse({ active: "false" });
      expect(result.filters).toEqual({ active: false });
    });

    it('should coerce "null" to null', () => {
      const result = parser.parse({ field: "null" });
      expect(result.filters).toEqual({ field: null });
    });

    it("should coerce integer strings to numbers", () => {
      const result = parser.parse({ count: "42" });
      expect(result.filters).toEqual({ count: 42 });
    });

    it("should coerce float strings to numbers", () => {
      const result = parser.parse({ price: "19.99" });
      expect(result.filters).toEqual({ price: 19.99 });
    });

    it("should keep non-numeric strings as strings", () => {
      const result = parser.parse({ name: "john" });
      expect(result.filters).toEqual({ name: "john" });
    });

    it("keeps hex strings as strings (not numbers)", () => {
      expect(parser.parse({ color: "0xff" }).filters.color).toBe("0xff");
    });
  });

  // ============================================================================
  // createQueryParser Factory
  // ============================================================================

  describe("createQueryParser factory", () => {
    it("should create parser with default options", () => {
      const p = createQueryParser();
      const result = p.parse({});
      expect(result.limit).toBe(20);
    });

    it("should create parser with custom options", () => {
      const p = createQueryParser({ maxLimit: 25, defaultLimit: 5 });
      const result = p.parse({});
      expect(result.limit).toBe(5);

      const capped = p.parse({ limit: "100" });
      expect(capped.limit).toBe(25);
    });
  });

  // ============================================================================
  // Full Query Parsing
  // ============================================================================

  describe("Full Query — Combined Parameters", () => {
    it("should parse a complex query with all features", () => {
      const result = parser.parse({
        page: "2",
        limit: "10",
        sort: "-createdAt,name",
        select: "title,content,-secret",
        populate: "author,category",
        search: "hello world",
        status: "active",
        price: { gte: "100", lte: "500" },
        tags: { in: "tech,science" },
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.sort).toEqual({ createdAt: -1, name: 1 });
      expect(result.select).toEqual({ title: 1, content: 1, secret: 0 });
      expect(result.populate).toBe("author,category");
      expect(result.search).toBe("hello world");
      expect(result.filters).toEqual({
        status: "active",
        price: { $gte: 100, $lte: 500 },
        tags: { $in: ["tech", "science"] },
      });
    });

    it("should handle completely empty query", () => {
      const result = parser.parse({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.sort).toBeUndefined();
      expect(result.select).toBeUndefined();
      expect(result.populate).toBeUndefined();
      expect(result.search).toBeUndefined();
      expect(result.after).toBeUndefined();
      expect(result.filters).toEqual({});
    });
  });
});
