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

import type { ParsedQuery, QueryParserInterface } from '../types/index.js';

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
const DANGEROUS_REGEX_PATTERNS = /(\{[0-9,]+\}|\*\+|\+\+|\?\+|(\(.+\))\+|\(\?\:|\\[0-9]|(\[.+\]).+(\[.+\]))/;

/** Maximum allowed regex pattern length */
const MAX_REGEX_LENGTH = 500;

/** Maximum allowed search query length */
const MAX_SEARCH_LENGTH = 200;

/** Maximum allowed filter depth (prevents filter bombs) */
const MAX_FILTER_DEPTH = 10;

/** Maximum allowed limit value */
const MAX_LIMIT = 1000;

/** Default limit for pagination */
const DEFAULT_LIMIT = 20;

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
}

/**
 * Arc's default query parser
 *
 * Converts URL query parameters to a structured query format:
 * - Pagination: ?page=1&limit=20
 * - Sorting: ?sort=-createdAt,name (- prefix = descending)
 * - Filtering: ?status=active&price[gte]=100&price[lte]=500
 * - Search: ?search=keyword
 * - Populate: ?populate=author,category
 * - Field selection: ?select=name,price,status
 * - Keyset pagination: ?after=cursor_value
 *
 * For advanced MongoDB features ($lookup, aggregations), use MongoKit's QueryParser.
 */
export class ArcQueryParser implements QueryParserInterface {
  private readonly maxLimit: number;
  private readonly defaultLimit: number;
  private readonly maxRegexLength: number;
  private readonly maxSearchLength: number;
  private readonly maxFilterDepth: number;

  /** Supported filter operators */
  private readonly operators: Record<string, string> = {
    eq: '$eq',
    ne: '$ne',
    gt: '$gt',
    gte: '$gte',
    lt: '$lt',
    lte: '$lte',
    in: '$in',
    nin: '$nin',
    like: '$regex',
    contains: '$regex',
    regex: '$regex',
    exists: '$exists',
  };

  constructor(options: ArcQueryParserOptions = {}) {
    this.maxLimit = options.maxLimit ?? MAX_LIMIT;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.maxRegexLength = options.maxRegexLength ?? MAX_REGEX_LENGTH;
    this.maxSearchLength = options.maxSearchLength ?? MAX_SEARCH_LENGTH;
    this.maxFilterDepth = options.maxFilterDepth ?? MAX_FILTER_DEPTH;
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

    // Extract populate
    const populate = this.parseString(q.populate);

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

  private parseSort(value: unknown): Record<string, 1 | -1> | undefined {
    if (!value) return undefined;

    const sortStr = String(value);
    const result: Record<string, 1 | -1> = {};

    for (const field of sortStr.split(',')) {
      const trimmed = field.trim();
      if (!trimmed) continue;

      // Validate field name (prevent injection)
      if (!/^-?[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) continue;

      if (trimmed.startsWith('-')) {
        result[trimmed.slice(1)] = -1;
      } else {
        result[trimmed] = 1;
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

    for (const field of selectStr.split(',')) {
      const trimmed = field.trim();
      if (!trimmed) continue;

      // Validate field name (prevent injection)
      if (!/^-?[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed)) continue;

      if (trimmed.startsWith('-')) {
        result[trimmed.slice(1)] = 0;
      } else {
        result[trimmed] = 1;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  private parseFilters(query: Record<string, unknown>): Record<string, unknown> {
    const reservedKeys = new Set([
      'page', 'limit', 'sort', 'populate', 'search', 'select',
      'after', 'cursor', 'lean', '_policyFilters',
    ]);

    const filters: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(query)) {
      if (reservedKeys.has(key)) continue;
      if (value === undefined || value === null) continue;

      // Validate field name (prevent injection)
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(key)) continue;

      // Handle nested object format from qs parser: { price: { gte: '40', lte: '100' } }
      // This happens when URL is ?price[gte]=40&price[lte]=100 and qs parses it
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const operatorObj = value as Record<string, unknown>;
        const operatorKeys = Object.keys(operatorObj);

        // Check if all keys are known operators
        const allOperators = operatorKeys.every(op => this.operators[op]);

        if (allOperators && operatorKeys.length > 0) {
          // Convert operator object: { gte: '40', lte: '100' } → { $gte: 40, $lte: 100 }
          const mongoFilters: Record<string, unknown> = {};
          for (const [op, opValue] of Object.entries(operatorObj)) {
            const mongoOp = this.operators[op];
            if (mongoOp) {
              mongoFilters[mongoOp] = this.parseFilterValue(opValue, op);
            }
          }
          filters[key] = mongoFilters;
          continue;
        }
      }

      // Handle key-based bracket notation: price[gte]=100 (when not parsed by qs)
      const match = key.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)(?:\[([a-z]+)\])?$/);
      if (!match) continue;

      const [, fieldName, operator] = match;
      if (!fieldName) continue;

      if (operator && this.operators[operator]) {
        // Operator filter: status[ne]=deleted → { status: { $ne: 'deleted' } }
        const mongoOp = this.operators[operator];
        const parsedValue = this.parseFilterValue(value, operator);

        if (!filters[fieldName]) {
          filters[fieldName] = {};
        }
        (filters[fieldName] as Record<string, unknown>)[mongoOp] = parsedValue;
      } else if (!operator) {
        // Direct equality: status=active → { status: 'active' }
        filters[fieldName] = this.parseFilterValue(value);
      }
    }

    return filters;
  }

  private parseFilterValue(value: unknown, operator?: string): unknown {
    // Handle arrays (for $in, $nin operators)
    if (operator === 'in' || operator === 'nin') {
      if (Array.isArray(value)) {
        return value.map(v => this.coerceValue(v));
      }
      if (typeof value === 'string' && value.includes(',')) {
        return value.split(',').map(v => this.coerceValue(v.trim()));
      }
      return [this.coerceValue(value)];
    }

    // Handle regex operators
    if (operator === 'like' || operator === 'contains' || operator === 'regex') {
      return this.sanitizeRegex(String(value));
    }

    // Handle exists operator
    if (operator === 'exists') {
      const str = String(value).toLowerCase();
      return str === 'true' || str === '1';
    }

    return this.coerceValue(value);
  }

  private coerceValue(value: unknown): unknown {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;

    // Try to parse as number
    if (typeof value === 'string') {
      const num = Number(value);
      if (!Number.isNaN(num) && value.trim() !== '') {
        return num;
      }
    }

    return value;
  }

  private sanitizeRegex(pattern: string): string {
    // Limit length
    let sanitized = pattern.slice(0, this.maxRegexLength);

    // Check for dangerous patterns
    if (DANGEROUS_REGEX_PATTERNS.test(sanitized)) {
      // Escape the entire pattern to treat as literal string
      sanitized = sanitized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export default ArcQueryParser;
