/**
 * Arc Query Parser - Default URL-to-Query Parser
 *
 * Framework-agnostic query parser that converts URL parameters to query options.
 * This is Arc's built-in parser; users can swap in MongoKit's QueryParser,
 * pgkit's parser, or any custom parser implementing QueryParserInterface.
 *
 * @example
 * // Use Arc default parser (auto-applied if no queryParser option)
 * defineResource({ name: 'product', adapter: ... });
 *
 * // Use MongoKit's QueryParser (recommended for MongoDB - has $lookup, aggregations, etc.)
 * // Fail-closed by default (mongokit >=3.25): invalid/blocked query input
 * // becomes HTTP 400 instead of a silently broadened result set.
 * import { QueryParser } from '@classytic/mongokit';
 * defineResource({
 *   name: 'product',
 *   adapter: ...,
 *   queryParser: new QueryParser(),
 * });
 *
 * // Use custom parser for SQL databases
 * defineResource({
 *   name: 'user',
 *   adapter: ...,
 *   queryParser: new PgQueryParser(),
 * });
 */

import {
  DEFAULT_LIMIT,
  MAX_FILTER_DEPTH,
  DEFAULT_MAX_LIMIT as MAX_LIMIT,
  MAX_REGEX_LENGTH,
  MAX_SEARCH_LENGTH,
  RESERVED_QUERY_PARAMS,
} from "../constants.js";
import { arcLog } from "../logger/index.js";
import type { ParsedQuery, PopulateOption, QueryParserInterface } from "../types/index.js";
import { ValidationError } from "./errors.js";
import { type FilterDialect, MONGO_DIALECT } from "./filter-dialect.js";

const log = arcLog("queryParser");

// ============================================================================
// Dangerous Patterns (ReDoS protection)
// ============================================================================

/**
 * Regex patterns that can cause catastrophic backtracking (ReDoS attacks)
 * Detects:
 * - Quantifiers: {n,m}
 * - Possessive quantifiers: *+, ++, ?+
 * - Nested quantifiers: (a+)+, (a*)*
 * - Backreferences: \1, \2, etc.
 */
const DANGEROUS_REGEX_PATTERNS =
  /(\{[0-9,]+\}|\*\+|\+\+|\?\+|(\(.+\))\+|\(\?:|\\[0-9]|(\[.+\]).+(\[.+\]))/;

// ============================================================================
// Arc Query Parser
// ============================================================================

export interface ArcQueryParserOptions {
  /** Maximum allowed limit value (default: 1000) */
  maxLimit?: number;
  /** Default limit for pagination (default: 20) */
  defaultLimit?: number;
  /** Maximum regex pattern length (default: 500) */
  maxRegexLength?: number;
  /** Maximum search query length (default: 200) */
  maxSearchLength?: number;
  /** Maximum filter nesting depth (default: 10) */
  maxFilterDepth?: number;
  /**
   * Whitelist of fields that can be filtered on.
   * When set, only these fields are accepted as filters — all others are silently dropped.
   * Also used by MCP to auto-derive filterable fields in tool schemas.
   */
  allowedFilterFields?: string[];
  /**
   * REFUSE a filter key that is not in {@link allowedFilterFields}, instead of
   * dropping it (default: `false` — today's drop behaviour, kept because arc
   * is published and an unconditional throw would reject requests that work).
   *
   * Dropping a filter does not fail, it **WIDENS**: the caller asked for a
   * narrower set and is silently answered with a broader one, HTTP 200. Two
   * live instances:
   *
   *   `?filters[status]=pending` → 200, every row `status:"verified"`
   *   `?productId=…` (the param is `skuRef`) → a different product's 75 units,
   *     filed for weeks as "quant leakage"
   *
   * Turn this on per-parser, or fleet-wide via `ARC_STRICT_QUERY_PARAMS`.
   * Mirrors the `ARC_STRICT_PERMISSIONS` precedent: off by default here, and
   * the HOST opts in from its env-loader so a forgotten `.env` line cannot
   * silently disable enforcement.
   *
   * Only the FILTER whitelist is covered. `allowedSortFields` /
   * `allowedOperators` keep dropping: a rejected sort or operator degrades
   * ordering, it does not widen the row set.
   */
  strictFilterFields?: boolean;
  /**
   * Whitelist of fields that can be sorted on.
   * When set, sort fields not in this list are silently dropped.
   * Also used by MCP to describe available sort options.
   */
  allowedSortFields?: string[];
  /**
   * Whitelist of filter operators (e.g. ['eq', 'ne', 'gt', 'lt', 'in']).
   * When set, only these operators are accepted — all others are dropped.
   * Also used by MCP to enrich list tool descriptions.
   */
  allowedOperators?: string[];
  /**
   * Datastore dialect for the EMITTED filter shape (operator tokens +
   * case-insensitive expression). Defaults to `MONGO_DIALECT`. Pass
   * `NEUTRAL_DIALECT` (or a custom one) to retarget the operator vocabulary
   * without writing a full `QueryParserInterface`.
   */
  dialect?: FilterDialect;
}

/**
 * Arc's default query parser
 *
 * Converts URL query parameters to a structured query format:
 * - Pagination: ?page=1&limit=20
 * - Sorting: ?sort=-createdAt,name (- prefix = descending)
 * - Filtering — TWO supported forms (both produce identical output):
 *     - Bare (default, terse):     `?status=active&price[gte]=100&price[lte]=500`
 *     - Bracket envelope:          `?filter[status]=active&filter[price][gte]=100`
 *   The envelope form matches the convention used by JSON:API / Stripe /
 *   most modern REST style guides, and is the safe choice on busy URLs
 *   that might otherwise collide with reserved meta keys (`page`, `sort`,
 *   `select`, `populate`, etc.). Operator notation (`[gte]`, `[lte]`,
 *   `[ne]`, `[in]`, ...) works inside either form.
 * - Search: ?search=keyword
 * - Populate: ?populate=author,category
 * - Field selection: ?select=name,price,status
 * - Keyset pagination: ?after=cursor_value
 *
 * **NOTE on parser portability.** `ArcQueryParser` accepts both filter
 * forms. Other parser implementations (`@classytic/mongokit`'s
 * `QueryParser`, custom hosts-side parsers) may accept only one form —
 * MongoKit historically only accepts the bare form. If your host swaps
 * `queryParser` to a different implementation, double-check which forms
 * it understands before publishing URLs that mix the two.
 *
 * For advanced MongoDB features ($lookup, aggregations), use MongoKit's QueryParser.
 */
export class ArcQueryParser implements QueryParserInterface {
  /**
   * PUBLIC, deliberately: `QueryResolver` reads it so it does not apply a second cap
   * on top of this one. Three layers capping independently, lowest winning silently,
   * is what made a 696-row chart of accounts render as 100.
   */
  readonly maxLimit: number;
  private readonly defaultLimit: number;
  private readonly maxRegexLength: number;
  private readonly maxSearchLength: number;
  private readonly maxFilterDepth: number;
  private readonly _allowedFilterFields?: Set<string>;
  private readonly _allowedSortFields?: Set<string>;
  private readonly _allowedOperators?: Set<string>;
  private readonly strictFilterFields: boolean;

  /** Allowed filter fields (used by MCP for auto-derive) */
  readonly allowedFilterFields?: readonly string[];
  /** Allowed sort fields (used by MCP for sort descriptions) */
  readonly allowedSortFields?: readonly string[];
  /** Allowed operators (used by MCP for operator descriptions) */
  readonly allowedOperators?: readonly string[];

  /**
   * Datastore dialect — owns the store-specific operator tokens + the
   * case-insensitive modifier. Defaults to Mongo (backward-compatible).
   */
  private readonly dialect: FilterDialect;

  /** Supported filter operators (neutral name → emitted token), from the dialect. */
  private get operators(): Readonly<Record<string, string>> {
    return this.dialect.operators;
  }

  constructor(options: ArcQueryParserOptions = {}) {
    this.dialect = options.dialect ?? MONGO_DIALECT;
    this.maxLimit = options.maxLimit ?? MAX_LIMIT;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.maxRegexLength = options.maxRegexLength ?? MAX_REGEX_LENGTH;
    this.maxSearchLength = options.maxSearchLength ?? MAX_SEARCH_LENGTH;
    this.maxFilterDepth = options.maxFilterDepth ?? MAX_FILTER_DEPTH;
    // `??` not `||`: an explicit `false` must beat the env, so a deployment can
    // opt a single parser out of a fleet-wide switch. A general default must
    // never override a specific instruction.
    this.strictFilterFields =
      options.strictFilterFields ?? process.env.ARC_STRICT_QUERY_PARAMS === "true";

    if (options.allowedFilterFields) {
      this._allowedFilterFields = new Set(options.allowedFilterFields);
      this.allowedFilterFields = options.allowedFilterFields;
    }
    if (options.allowedSortFields) {
      this._allowedSortFields = new Set(options.allowedSortFields);
      this.allowedSortFields = options.allowedSortFields;
    }
    if (options.allowedOperators) {
      this._allowedOperators = new Set(options.allowedOperators);
      this.allowedOperators = options.allowedOperators;
    }
  }

  /**
   * Parse URL query parameters into structured query options
   */
  parse(query: Record<string, unknown> | null | undefined): ParsedQuery {
    const q = query ?? {};

    // Extract pagination params
    const page = this.parseNumber(q.page, 1);
    const limit = Math.min(this.parseNumber(q.limit, this.defaultLimit), this.maxLimit);
    const after = this.parseString(q.after ?? q.cursor);

    // Extract sort
    const sort = this.parseSort(q.sort);

    // Extract populate — handles both simple string and bracket notation object
    const { populate, populateOptions } = this.parsePopulate(q.populate);

    // Extract search
    const search = this.parseSearch(q.search);

    // Extract select
    const select = this.parseSelect(q.select);

    // Extract filters (everything else)
    const filters = this.parseFilters(q);

    return {
      filters,
      limit,
      sort,
      populate,
      populateOptions,
      search,
      page: after ? undefined : page,
      after,
      select,
    };
  }

  // ============================================================================
  // Parse Helpers
  // ============================================================================

  private parseNumber(value: unknown, defaultValue: number): number {
    if (value === undefined || value === null) return defaultValue;
    const num = parseInt(String(value), 10);
    return Number.isNaN(num) ? defaultValue : Math.max(1, num);
  }

  private parseString(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const str = String(value).trim();
    return str.length > 0 ? str : undefined;
  }

  /**
   * Parse populate parameter — handles both simple string and bracket notation.
   *
   * Simple: ?populate=author,category → { populate: 'author,category' }
   * Bracket: ?populate[author][select]=name,email → { populateOptions: [{ path: 'author', select: 'name email' }] }
   */
  private parsePopulate(value: unknown): { populate?: string; populateOptions?: PopulateOption[] } {
    if (value === undefined || value === null) return {};

    // Simple string: ?populate=author,category
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? { populate: trimmed } : {};
    }

    // Bracket notation object: ?populate[author][select]=name,email
    // qs parses this as { author: { select: 'name,email' } }
    if (typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) return {};

      const options: PopulateOption[] = [];
      for (const path of keys) {
        // Validate path name (prevent injection)
        if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(path)) continue;

        const config = obj[path];
        if (typeof config === "object" && config !== null && !Array.isArray(config)) {
          const cfg = config as Record<string, unknown>;
          const option: PopulateOption = { path };

          // Parse select: convert comma-separated to space-separated (Mongoose format)
          if (typeof cfg.select === "string") {
            option.select = cfg.select
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .join(" ");
          }

          // Parse match (filter conditions)
          if (typeof cfg.match === "object" && cfg.match !== null) {
            option.match = cfg.match as Record<string, unknown>;
          }

          options.push(option);
        } else {
          // Simple value like populate[author]=true → treat as simple populate
          options.push({ path });
        }
      }

      return options.length > 0 ? { populateOptions: options } : {};
    }

    return {};
  }

  private parseSort(value: unknown): Record<string, 1 | -1> | undefined {
    if (!value) return undefined;

    const sortStr = String(value);
    const result: Record<string, 1 | -1> = {};

    for (const field of sortStr.split(",")) {
      const trimmed = field.trim();
      if (!trimmed) continue;

      // Validate field name (prevent injection)
      if (!/^-?[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) continue;

      const fieldName = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;

      // Enforce sort field whitelist
      if (this._allowedSortFields && !this._allowedSortFields.has(fieldName)) continue;

      if (trimmed.startsWith("-")) {
        result[fieldName] = -1;
      } else {
        result[fieldName] = 1;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  private parseSearch(value: unknown): string | undefined {
    if (!value) return undefined;

    const search = String(value).trim();
    if (search.length === 0) return undefined;
    if (search.length > this.maxSearchLength) {
      return search.slice(0, this.maxSearchLength);
    }

    return search;
  }

  private parseSelect(value: unknown): Record<string, 0 | 1> | undefined {
    if (!value) return undefined;

    const selectStr = String(value);
    const result: Record<string, 0 | 1> = {};

    for (const field of selectStr.split(",")) {
      const trimmed = field.trim();
      if (!trimmed) continue;

      // Validate field name (prevent injection)
      if (!/^-?[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) continue;

      if (trimmed.startsWith("-")) {
        result[trimmed.slice(1)] = 0;
      } else {
        result[trimmed] = 1;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * Check if a value exceeds the maximum nesting depth.
   * Prevents filter bombs where deeply nested objects consume excessive memory/CPU.
   */
  private exceedsDepth(obj: unknown, currentDepth: number = 0): boolean {
    if (currentDepth > this.maxFilterDepth) return true;
    if (obj === null || obj === undefined) return false;
    if (Array.isArray(obj)) {
      return obj.some((v) => this.exceedsDepth(v, currentDepth));
    }
    if (typeof obj !== "object") return false;
    return Object.values(obj as Record<string, unknown>).some((v) =>
      this.exceedsDepth(v, currentDepth + 1),
    );
  }

  /**
   * Parse all filter entries from the query, supporting BOTH the bare
   * top-level form and the bracket-wrapped `filter[...]` envelope.
   *
   * Two equivalent ways to express the same query:
   *   - Bare (legacy, arc default): `?status=active&price[gte]=40`
   *   - Bracket envelope (REST convention): `?filter[status]=active&filter[price][gte]=40`
   *
   * Both forms parse to the same `filters: { status: 'active', price: { $gte: 40 } }`.
   * The envelope form mirrors the convention used by most REST API style
   * guides (JSON:API, Stripe API, etc.) and disambiguates filter fields
   * from reserved meta params on busy URLs — a query string with a field
   * literally named `page` or `sort` can't collide with the framework's
   * meta keys when wrapped under `filter[...]`. The bare form stays as
   * the default since it's the shortest path for simple queries; expect
   * it to remain supported indefinitely.
   *
   * Precedence when the same key appears in both forms:
   *   `?status=closed&filter[status]=active` → bare wins (`status: closed`).
   * Mixing should be rare; the deterministic rule avoids silent surprises.
   */
  private parseFilters(query: Record<string, unknown>): Record<string, unknown> {
    const filters: Record<string, unknown> = {};

    // 1. Bracket envelope form: ?filter[foo]=X / ?filter[price][gte]=40
    //    `qs` parses these as `query.filter = { foo: 'X', price: { gte: '40' } }`.
    //    Process FIRST so bare top-level filters can override on key clash.
    const envelope = query.filter;
    if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
      for (const [key, value] of Object.entries(envelope as Record<string, unknown>)) {
        this.applyFilterEntry(filters, key, value);
      }
    }

    // 2. Bare top-level form: ?foo=X / ?price[gte]=40 (the historical default).
    for (const [key, value] of Object.entries(query)) {
      if (RESERVED_QUERY_PARAMS.has(key)) continue;
      this.applyFilterEntry(filters, key, value);
    }

    return filters;
  }

  /**
   * Apply one filter entry — used by both the bracket-envelope branch and
   * the bare top-level branch of `parseFilters`. Centralising the field-
   * validation + operator-conversion logic keeps the two forms in
   * lockstep; a future regex/security tweak only changes one place.
   */
  private applyFilterEntry(filters: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined || value === null) return;

    // Validate field name (prevent injection)
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*(?:\[[a-z]+\])?$/.test(key)) return;

    // Strip optional `[operator]` suffix when checking against the field
    // whitelist — `price[gte]` and `price` should both be gated by the
    // `price` entry in `allowedFilterFields`.
    const bareKey = key.replace(/\[[a-z]+\]$/, "");
    if (this._allowedFilterFields && !this._allowedFilterFields.has(bareKey)) {
      // Dropping a filter WIDENS the result set — the caller asked to narrow
      // and gets a broader answer with a 200. Under `strictFilterFields` we
      // refuse instead. See the option's docblock for the two live incidents.
      if (this.strictFilterFields) {
        throw new ValidationError(
          `Unknown filter field: ${bareKey}. Allowed: ${[...this._allowedFilterFields].sort().join(", ")}`,
        );
      }
      return;
    }

    // Enforce max filter depth (prevents filter bombs)
    if (this.exceedsDepth(value)) return;

    // Handle nested object format from qs parser: { price: { gte: '40', lte: '100' } }
    // This happens when URL is ?price[gte]=40&price[lte]=100 and qs parses it
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const operatorObj = value as Record<string, unknown>;
      const operatorKeys = Object.keys(operatorObj);

      // Check if all keys are known operators (respecting operator whitelist)
      const allOperators = operatorKeys.every(
        (op) => this.operators[op] && (!this._allowedOperators || this._allowedOperators.has(op)),
      );

      // Check if all keys are known operators (ignoring whitelist)
      const allKnownOperators = operatorKeys.every((op) => this.operators[op]);

      if (allOperators && operatorKeys.length > 0) {
        // All operators known and allowed — convert via the dialect:
        // { gte: '40', lte: '100' } → { $gte: 40, $lte: 100 } (Mongo default).
        const fieldOps: Record<string, unknown> = {};
        let needsCaseInsensitive = false;
        for (const [op, opValue] of Object.entries(operatorObj)) {
          const token = this.operators[op];
          if (token) {
            fieldOps[token] = this.parseFilterValue(opValue, op);
            // v2.10.9 — `contains` / `like` promise case-insensitive matching
            // in their OpenAPI descriptions. The dialect expresses that (Mongo:
            // `$options: 'i'`). `regex` stays caller-controlled. See the
            // bracket-notation path below for the companion stamp.
            if (op === "contains" || op === "like") {
              needsCaseInsensitive = true;
            }
          }
        }
        if (needsCaseInsensitive) {
          Object.assign(fieldOps, this.dialect.caseInsensitiveModifier());
        }
        filters[key] = fieldOps;
        return;
      }

      // Keys are known operators but blocked by whitelist — drop the field entirely
      if (allKnownOperators && this._allowedOperators) {
        return;
      }
    }

    // Handle key-based bracket notation: price[gte]=100 (when not parsed by qs)
    const match = key.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)(?:\[([a-z]+)\])?$/);
    if (!match) return;

    const [, fieldName, operator] = match;
    if (!fieldName) return;

    if (
      operator &&
      this.operators[operator] &&
      (!this._allowedOperators || this._allowedOperators.has(operator))
    ) {
      // Operator filter: status[ne]=deleted → { status: { $ne: 'deleted' } }
      const token = this.operators[operator];
      const parsedValue = this.parseFilterValue(value, operator);

      if (!filters[fieldName]) {
        filters[fieldName] = {};
      }
      const fieldFilter = filters[fieldName] as Record<string, unknown>;
      fieldFilter[token] = parsedValue;

      // v2.10.9 — `contains` and `like` advertise case-insensitive matching in
      // their OpenAPI descriptions ("Contains substring (case-insensitive)" /
      // "Pattern match (case-insensitive)"). The dialect expresses that shape
      // (Mongo: `$options: 'i'`). The `regex` operator is left untouched —
      // callers supplying a raw regex pattern control flags themselves (and can
      // still use `[contains]` / `[like]` for the documented case-insensitive shape).
      if (operator === "contains" || operator === "like") {
        Object.assign(fieldFilter, this.dialect.caseInsensitiveModifier());
      }
    } else if (!operator) {
      // Direct equality: status=active → { status: 'active' }
      filters[fieldName] = this.parseFilterValue(value);
    }
  }

  private parseFilterValue(value: unknown, operator?: string): unknown {
    // Handle arrays (for $in, $nin operators)
    if (operator === "in" || operator === "nin") {
      if (Array.isArray(value)) {
        return value.map((v) => this.coerceValue(v));
      }
      if (typeof value === "string" && value.includes(",")) {
        return value.split(",").map((v) => this.coerceValue(v.trim()));
      }
      return [this.coerceValue(value)];
    }

    // Handle regex operators
    if (operator === "like" || operator === "contains" || operator === "regex") {
      return this.sanitizeRegex(String(value));
    }

    // Handle exists operator
    if (operator === "exists") {
      const str = String(value).toLowerCase();
      return str === "true" || str === "1";
    }

    return this.coerceValue(value);
  }

  private coerceValue(value: unknown): unknown {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;

    // Try to parse as number
    if (typeof value === "string") {
      const num = Number(value);
      if (!Number.isNaN(num) && value.trim() !== "") {
        return num;
      }
    }

    return value;
  }

  // ============================================================================
  // OpenAPI Schema Generation
  // ============================================================================

  /**
   * Generate OpenAPI-compatible JSON Schema for query parameters.
   * Arc's defineResource() auto-detects this method and uses it
   * to document list endpoint query parameters in OpenAPI/Swagger.
   */
  getQuerySchema(): {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  } {
    const operatorEntries = Object.entries(this.operators);
    const operatorLines = operatorEntries.map(([op, mongoOp]) => {
      const desc: Record<string, string> = {
        eq: "Equal (default when no operator specified)",
        ne: "Not equal",
        gt: "Greater than",
        gte: "Greater than or equal",
        lt: "Less than",
        lte: "Less than or equal",
        in: "In list (comma-separated values)",
        nin: "Not in list",
        like: "Pattern match (case-insensitive)",
        contains: "Contains substring (case-insensitive)",
        regex: "Regex pattern",
        exists: "Field exists (true/false)",
      };
      return `  ${op} → ${mongoOp}: ${desc[op] || op}`;
    });

    return {
      type: "object",
      properties: {
        page: {
          type: "integer",
          description: "Page number for offset pagination",
          default: 1,
          minimum: 1,
        },
        limit: {
          type: "integer",
          /**
           * The cap is DOCUMENTED here, not enforced — deliberately.
           *
           * Both layers that handle `limit` CLAMP it: this parser
           * (`Math.min(…, this.maxLimit)`) and `QueryResolver`. Emitting
           * `maximum` contradicted them, because arc layers this schema as the
           * route's `listQuery` and Fastify validates the querystring BEFORE
           * either runs — so the clamp was unreachable and `?limit=200` became a
           * hard 400.
           *
           * That combination is worse than either policy alone. Asking for more
           * rows than allowed is a benign over-ask with an obvious right answer
           * (give the maximum); turning it into a validation failure means a UI
           * passing a generous page size gets NOTHING, and a caller that does not
           * inspect the error body renders it as an empty list — a 400 disguised
           * as "no results", which is the hardest kind to find.
           *
           * A deployment wanting refusal instead of clamping should say so in the
           * parser's policy, where both halves can agree, not in a schema that
           * silently outranks them. Mirrors the same fix in mongokit's
           * `buildQuerySchema`.
           */
          description: `Number of items per page (values above ${this.maxLimit} are capped to ${this.maxLimit})`,
          default: this.defaultLimit,
          minimum: 1,
        },
        sort: {
          type: "string",
          description:
            "Sort fields (comma-separated). Prefix with - for descending. Example: -createdAt,name",
        },
        search: {
          type: "string",
          description: "Full-text search query",
          maxLength: this.maxSearchLength,
        },
        select: {
          type: "string",
          description:
            "Fields to include/exclude (comma-separated). Prefix with - to exclude. Example: name,email,-password",
        },
        populate: {
          type: "string",
          description: "Fields to populate/join (comma-separated). Example: author,category",
        },
        after: {
          type: "string",
          description: "Cursor value for keyset pagination",
        },
        _filterOperators: {
          type: "string",
          description: [
            "Available filter operators (use as field[operator]=value):",
            ...operatorLines,
          ].join("\n"),
        },
      },
    };
  }

  // ============================================================================
  // Regex Sanitization
  // ============================================================================

  private sanitizeRegex(pattern: string): string {
    // Limit length
    const truncated = pattern.length > this.maxRegexLength;
    let sanitized = pattern.slice(0, this.maxRegexLength);

    // Check for dangerous patterns
    if (DANGEROUS_REGEX_PATTERNS.test(sanitized)) {
      // Escape the entire pattern to treat as literal string.
      // v2.10.9 — surface a warning so callers stop silently debugging
      // a pattern that was neutered to a literal. Gated through `arcLog`
      // which honors `ARC_SUPPRESS_WARNINGS=1` for hosts that want quiet
      // production logs.
      sanitized = sanitized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      log.warn(
        `regex pattern matched a ReDoS-dangerous shape and was escaped to a literal string. original="${pattern}" sanitized="${sanitized}"`,
      );
    } else if (truncated) {
      log.warn(
        `regex pattern exceeded maxRegexLength (${this.maxRegexLength}) and was truncated. original-length=${pattern.length}`,
      );
    }

    return sanitized;
  }
}

/**
 * Create a new ArcQueryParser instance
 */
export function createQueryParser(options?: ArcQueryParserOptions): ArcQueryParser {
  return new ArcQueryParser(options);
}
