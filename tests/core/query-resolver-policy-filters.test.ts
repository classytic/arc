/**
 * A client-supplied `_policyFilters` must never reach the query parser.
 *
 * Trusted policy is a request DECORATION (`request._policyFilters`, written by
 * the permission middleware) that `createRequestContext` lifts into
 * `metadata` — it never enters `req.query`, which is Fastify's parsed
 * querystring. Verified: a `preHandler` setting `request._policyFilters` leaves
 * `request.query` untouched. So the key can only appear here because a CLIENT
 * put it in the URL, and it is inert either way — `QueryResolver` reads policy
 * from `metadata`, never from the query.
 *
 * The bug was placement. The old `delete` ran on `parsed.filters`, i.e. AFTER
 * `queryParser.parse()`, so on the one path that needed it, it could never
 * run: a KIT parser validates every key against the resource's
 * `allowedFilterFields` and throws during the parse. Arc's own
 * `ArcQueryParser` skips the key via `RESERVED_QUERY_PARAMS`, so the two
 * parsers answered the same request differently — arc ignored the probe,
 * mongokit 400'd it (`Blocked filter field not in allowlist: _policyFilters`).
 *
 * Stripping pre-parse makes kits agree with arc. The trade, stated so it is
 * not rediscovered as a regression: that probe is now silently dropped rather
 * than rejected.
 *
 * The strict parser below is the minimum faithful stand-in for kit behaviour:
 * reject any key not in the allowlist, at parse time.
 */

import { describe, expect, it } from "vitest";
import { QueryResolver } from "../../src/core/QueryResolver.js";
import type {
  ArcInternalMetadata,
  IRequestContext,
  QueryParserInterface,
} from "../../src/types/index.js";

/** A kit-style parser: unknown filter keys are a 400, not a silent skip. */
function strictParser(allowedFilterFields: string[]): QueryParserInterface {
  const RESERVED = new Set(["page", "limit", "sort", "select", "populate", "search", "after"]);
  return {
    parse(query: Record<string, unknown> = {}) {
      const filters: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(query ?? {})) {
        if (RESERVED.has(key)) continue;
        if (!allowedFilterFields.includes(key)) {
          throw new Error(`Blocked filter field not in allowlist: ${key}`);
        }
        filters[key] = value;
      }
      return { filters, page: 1, limit: 20 };
    },
  } as unknown as QueryParserInterface;
}

function createReq(overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    params: {},
    query: {},
    body: {},
    user: null,
    headers: {},
    ...overrides,
  } as IRequestContext;
}

describe("QueryResolver — `_policyFilters` never reaches the parser", () => {
  it("a CLIENT-supplied `?_policyFilters=` does not 400 under an allowlist parser", () => {
    const resolver = new QueryResolver({ queryParser: strictParser(["status"]) });
    const req = createReq({
      query: { status: "open", _policyFilters: { ownerId: "u1" } } as Record<string, unknown>,
    });

    expect(() => resolver.resolve(req)).not.toThrow();
  });

  it("still APPLIES the policy from trusted metadata — stripping the query copy is not a bypass", () => {
    const resolver = new QueryResolver({ queryParser: strictParser(["status"]) });
    const req = createReq({ query: { status: "open" } as Record<string, unknown> });
    const meta = { _policyFilters: { ownerId: "u1" } } as unknown as ArcInternalMetadata;

    const resolved = resolver.resolve(req, meta);

    // The policy must survive into the outgoing filter. This is the assertion
    // that keeps the fix honest: silently dropping `_policyFilters` everywhere
    // would make this test fail rather than quietly widen every list.
    expect(JSON.stringify(resolved.filters)).toContain("ownerId");
  });

  it("does not mutate the caller's `req.query`", () => {
    const resolver = new QueryResolver({ queryParser: strictParser(["status"]) });
    const query = { status: "open", _policyFilters: { ownerId: "u1" } } as Record<string, unknown>;
    const req = createReq({ query });

    resolver.resolve(req);

    // `req.query` is shared with the rest of the request lifecycle — the strip
    // is a copy, never an in-place delete.
    expect(query._policyFilters).toEqual({ ownerId: "u1" });
  });
});
