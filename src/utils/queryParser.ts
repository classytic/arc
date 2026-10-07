/**
 * Arc's default URL-to-query parser. Reading the URL is repo-core's shared grammar (the same
 * contract as mongokit's `QueryParser` and `parseUrl`); this adds arc's populate handling and
 * emits filters through a {@link FilterDialect}. Swap in any `QueryParserInterface` via
 * `defineResource({ queryParser })`.
 */

import { readEnv } from "@classytic/primitives/environment";
import {
  isQueryGrammarError,
  OPERATOR_DESCRIPTIONS,
  type QueryGrammarError,
  readFilterClauses,
  readPageRequest,
  readSearch,
  readSelect,
  readSort,
  URL_OPERATORS,
} from "@classytic/repo-core/query-parser";
import {
  DEFAULT_LIMIT,
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

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

export interface ArcQueryParserOptions {
  /** Cap on `limit`; a larger request is clamped to it (default: 1000). */
  maxLimit?: number;
  /** Per-page count when the URL omits `limit` (default: 20). */
  defaultLimit?: number;
  /** Longest text-operator value or regex pattern (default: 200). */
  maxRegexLength?: number;
  /** Longest `search` (default: 200). */
  maxSearchLength?: number;
  /** Filterable fields. Also used by MCP to derive filterable fields. */
  allowedFilterFields?: string[];
  /**
   * REFUSE (400) a field, operator or sort field outside its allowlist — a dropped filter silently
   * WIDENS the read. Default `true`; `false` (or `ARC_STRICT_QUERY_PARAMS=false`) logs and drops
   * those instead. Malformed or smuggled input (`$where`, `x[$ne]`) is refused either way.
   */
  strictFilterFields?: boolean;
  /** Sortable fields. Also used by MCP. */
  allowedSortFields?: string[];
  /** URL operator names permitted in `field[op]` (e.g. `['in', 'gte']`). Also used by MCP. */
  allowedOperators?: string[];
  /** The emitted filter shape. Default `MONGO_DIALECT`. */
  dialect?: FilterDialect;
}

/**
 * Arc's default query parser:
 * - Paging `?page=1&limit=20`, keyset `?after=cursor`; sort `?sort=-createdAt,name`
 * - Filters bare (`?status=active&price[gte]=100`) or in the `?filter[...]` envelope, which
 *   avoids collisions with reserved keys (`page`, `sort`, ...)
 * - Search `?search=`, populate `?populate=a,b`, select `?select=a,-b`
 */
export class ArcQueryParser implements QueryParserInterface {
  /**
   * Public so `QueryResolver` reuses this cap instead of stacking its own
   * (independent caps silently truncate to the lowest).
   */
  readonly maxLimit: number;
  private readonly defaultLimit: number;
  private readonly maxRegexLength: number;
  private readonly maxSearchLength: number;
  private readonly strict: boolean;
  private readonly dialect: FilterDialect;

  /** Allowed filter fields (used by MCP for auto-derive) */
  readonly allowedFilterFields?: readonly string[];
  /** Allowed sort fields (used by MCP for sort descriptions) */
  readonly allowedSortFields?: readonly string[];
  /** Allowed operators (used by MCP for operator descriptions) */
  readonly allowedOperators?: readonly string[];

  constructor(options: ArcQueryParserOptions = {}) {
    this.dialect = options.dialect ?? MONGO_DIALECT;
    this.maxLimit = options.maxLimit ?? MAX_LIMIT;
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.maxRegexLength = options.maxRegexLength ?? MAX_REGEX_LENGTH;
    this.maxSearchLength = options.maxSearchLength ?? MAX_SEARCH_LENGTH;
    // `??` not `||`: an explicit per-parser `false` must beat the env switch.
    this.strict =
      options.strictFilterFields ?? readEnv(process.env).bool("ARC_STRICT_QUERY_PARAMS", true);
    if (options.allowedFilterFields) this.allowedFilterFields = options.allowedFilterFields;
    if (options.allowedSortFields) this.allowedSortFields = options.allowedSortFields;
    if (options.allowedOperators) this.allowedOperators = options.allowedOperators;
  }

  /** Parse URL query parameters into structured query options. Invalid input is a 400. */
  parse(query: Record<string, unknown> | null | undefined): ParsedQuery {
    const q = query ?? {};
    // Lenient mode relaxes the ALLOWLISTS only: a syntax or value refusal is still a 400.
    const onInvalid = this.strict
      ? undefined
      : (error: QueryGrammarError) => {
          if (error.meta.kind !== "policy") throw error;
          this.drop(error);
        };

    const page = this.read(
      () =>
        readPageRequest(
          { page: q.page, limit: q.limit, after: q.after, cursor: q.cursor },
          { defaultLimit: this.defaultLimit, maxLimit: this.maxLimit },
        ),
      { limit: Math.min(this.defaultLimit, this.maxLimit) },
    );
    const { clauses } = this.read(
      () =>
        readFilterClauses(q, {
          allowedFilterFields: this.allowedFilterFields,
          allowedOperators: this.allowedOperators,
          maxTextLength: this.maxRegexLength,
          reservedParams: [...RESERVED_QUERY_PARAMS],
          onInvalid,
        }),
      { clauses: [], extensions: [] },
    );
    const { populate, populateOptions } = this.parsePopulate(q.populate);

    return {
      filters: this.dialect.emit(clauses),
      limit: page.limit,
      sort: this.read(
        () => readSort(q.sort, { allowedSortFields: this.allowedSortFields, onInvalid }),
        undefined,
      ),
      populate,
      populateOptions,
      search: this.read(
        () => readSearch(q.search, { maxSearchLength: this.maxSearchLength }),
        undefined,
      ),
      page: page.after ? undefined : (page.page ?? 1),
      after: page.after,
      select: this.read(() => readSelect(q.select, { onInvalid }), undefined),
    };
  }

  /** A grammar refusal is a 400 (`ValidationError`) — unless lenient and only an allowlist miss. */
  private read<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (error) {
      if (!isQueryGrammarError(error)) throw error;
      if (this.strict || error.meta.kind !== "policy") throw toValidationError(error);
      this.drop(error);
      return fallback;
    }
  }

  private drop(error: QueryGrammarError): void {
    log.warn(`query input dropped (ARC_STRICT_QUERY_PARAMS=false): ${error.message}`);
  }

  /**
   * Simple `?populate=author,category`, or bracket `?populate[author][select]=name,email` and
   * `?populate[author][match][field]=value` (field equality only).
   */
  private parsePopulate(value: unknown): { populate?: string; populateOptions?: PopulateOption[] } {
    if (value === undefined || value === null) return {};

    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? { populate: trimmed } : {};
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      const options: PopulateOption[] = [];
      for (const [path, config] of Object.entries(value as Record<string, unknown>)) {
        if (!FIELD_RE.test(path)) {
          throw new ValidationError(`Populate path "${path}" is not a field path`);
        }
        if (typeof config === "object" && config !== null && !Array.isArray(config)) {
          const cfg = config as Record<string, unknown>;
          const option: PopulateOption = { path };
          // Comma-separated → space-separated (Mongoose format)
          if (typeof cfg.select === "string") {
            option.select = cfg.select
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .join(" ");
          }
          if (cfg.match !== undefined) option.match = this.parsePopulateMatch(path, cfg.match);
          options.push(option);
        } else {
          // populate[author]=true → a simple populate
          options.push({ path });
        }
      }
      return options.length > 0 ? { populateOptions: options } : {};
    }

    return {};
  }

  /**
   * A populate `match` is plain field EQUALITY in bracket form (`populate[p][match][f]=v`). A `$`
   * key, a nested object or a non-object `match` (a JSON string) is refused, never passed to the
   * driver or dropped — a dropped match populates every document.
   */
  private parsePopulateMatch(path: string, match: unknown): Record<string, unknown> {
    if (typeof match !== "object" || match === null || Array.isArray(match)) {
      throw new ValidationError(
        `Populate match on "${path}" must use bracket form: populate[${path}][match][field]=value`,
      );
    }
    for (const [key, value] of Object.entries(match)) {
      if (!FIELD_RE.test(key) || (typeof value === "object" && value !== null)) {
        throw new ValidationError(
          `Populate match on "${path}" accepts field equality only: "${key}"`,
        );
      }
    }
    return match as Record<string, unknown>;
  }

  /** JSON Schema for list query parameters (auto-detected by `defineResource`). */
  getQuerySchema(): {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  } {
    const allowed = this.allowedOperators;
    const operators = allowed ? URL_OPERATORS.filter((op) => allowed.includes(op)) : URL_OPERATORS;
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
           * No `maximum` — deliberately. This schema validates the querystring
           * BEFORE the parser/QueryResolver clamp runs, so a `maximum` would turn
           * a benign over-ask into a 400 instead of capping it.
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
            ...operators.map((op) => `  ${op}: ${OPERATOR_DESCRIPTIONS[op] ?? op}`),
          ].join("\n"),
        },
      },
    };
  }
}

/** Create a new ArcQueryParser instance. */
export function createQueryParser(options?: ArcQueryParserOptions): ArcQueryParser {
  return new ArcQueryParser(options);
}

/** The grammar's refusal as arc's 400, keeping the offending parameter for `details[]`. */
function toValidationError(error: QueryGrammarError): ValidationError {
  return new ValidationError(error.message, [
    { field: error.meta.param, message: error.meta.reason },
  ]);
}
