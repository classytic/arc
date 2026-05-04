/**
 * expectArc — Arc-specific response assertions
 *
 * Wraps a Fastify `app.inject` response and exposes fluent assertions for
 * the arc response envelope. Replaces the ~6 patterns repeated hundreds of
 * times across the test suite:
 *
 *   expect(res.statusCode).toBe(200);
 *   expect(JSON.parse(res.body).success).toBe(true);
 *   expect(JSON.parse(res.body).data.password).toBeUndefined();
 *
 * becomes
 *
 *   expectArc(res).ok().hidesField('password');
 *
 * Every helper returns the assertion object so you can chain. `.body` /
 * `.data` are lazy accessors — they parse once and cache, so repeated access
 * is cheap.
 *
 * Assertions use `vitest`'s `expect` internally — import this only from
 * test files or modules that run under vitest.
 */

import { expect } from "vitest";

export interface ArcResponseLike {
  statusCode: number;
  body: string;
}

export interface ArcAssertion {
  /** Raw response — kept for ad-hoc drill-down. */
  readonly response: ArcResponseLike;
  /** Parsed body (JSON). Cached. */
  readonly body: Record<string, unknown>;
  /** `body.data` — undefined for failed responses. */
  readonly data: unknown;
  /** Full fluent chain below — every method returns `this`. */
  ok(status?: number): ArcAssertion;
  failed(status?: number): ArcAssertion;
  unauthorized(): ArcAssertion;
  forbidden(): ArcAssertion;
  notFound(): ArcAssertion;
  validationError(): ArcAssertion;
  conflict(): ArcAssertion;
  hasData(): ArcAssertion;
  hasStatus(status: number): ArcAssertion;
  hidesField(field: string): ArcAssertion;
  showsField(field: string): ArcAssertion;
  /**
   * Asserts the arc paginated-list envelope: `success`, `docs[]`, and at
   * least one of `page`/`limit`/`total`/`hasNext`/`hasPrev`. `expected`
   * optionally pins specific fields.
   */
  paginated(expected?: {
    page?: number;
    limit?: number;
    total?: number;
    hasNext?: boolean;
    hasPrev?: boolean;
  }): ArcAssertion;
  /** Assert `body.error` (or `body.message`) matches the given string or regex. */
  hasError(matcher: string | RegExp): ArcAssertion;
  /** Assert a specific key on `body.meta` or flattened top-level (matches sendControllerResponse flattening). */
  hasMeta(key: string, value?: unknown): ArcAssertion;
}

// ============================================================================
// Implementation
// ============================================================================

function parseBody(response: ArcResponseLike): Record<string, unknown> {
  if (response.body === "" || response.body === undefined || response.body === null) {
    return {};
  }
  try {
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `expectArc: response body is not valid JSON (statusCode=${response.statusCode}): ${(err as Error).message}\nBody: ${response.body.slice(0, 200)}`,
    );
  }
}

export function expectArc(response: ArcResponseLike): ArcAssertion {
  let cachedBody: Record<string, unknown> | null = null;
  const getBody = (): Record<string, unknown> => {
    cachedBody ??= parseBody(response);
    return cachedBody;
  };

  const assertion: ArcAssertion = {
    response,
    get body() {
      return getBody();
    },
    get data() {
      return getBody().data;
    },

    ok(status = 200) {
      expect(
        response.statusCode,
        `expected 2xx (${status}) but got ${response.statusCode}. Body: ${response.body.slice(0, 200)}`,
      ).toBe(status);
      // No envelope: HTTP status discriminates success vs error. Body must parse
      // (handled by getBody throwing on invalid JSON) and may carry any shape.
      getBody();
      return assertion;
    },

    failed(status) {
      if (status !== undefined) {
        expect(response.statusCode).toBe(status);
      } else {
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
      }
      // No envelope: failure shape is the canonical ErrorContract (`code`, `message`, `status`).
      const body = getBody();
      expect(body.code, "expected ErrorContract.code on failed response").toBeDefined();
      return assertion;
    },

    unauthorized() {
      return assertion.failed(401);
    },

    forbidden() {
      return assertion.failed(403);
    },

    notFound() {
      return assertion.failed(404);
    },

    validationError() {
      return assertion.failed(400);
    },

    conflict() {
      return assertion.failed(409);
    },

    hasData() {
      // Single-doc responses have no envelope — body itself IS the data. Treat
      // a non-empty parsed body as proof. Falls back to the legacy `data`
      // field for paginated/bare-list shapes that still carry it.
      const body = getBody();
      const hasContent = Object.keys(body).length > 0;
      expect(hasContent, "expected response body to be defined").toBe(true);
      return assertion;
    },

    hasStatus(status) {
      expect(response.statusCode).toBe(status);
      return assertion;
    },

    hidesField(field) {
      // Single-doc responses have no envelope — body itself IS the data. For
      // paginated/list responses, `body.data` is the array; field checks at
      // the array level are no-ops, so we only inspect the top-level body.
      const body = getBody();
      expect(
        body as Record<string, unknown>,
        `expected field '${field}' to be hidden from response`,
      ).not.toHaveProperty(field);
      return assertion;
    },

    showsField(field) {
      const body = getBody();
      expect(
        body as Record<string, unknown>,
        `expected field '${field}' on response`,
      ).toHaveProperty(field);
      return assertion;
    },

    paginated(expected) {
      const body = getBody();
      // No envelope: paginated wire shape is `{ method, data: T[], page, limit, total, ... }`.
      // Bare lists are `{ data: T[] }`. Both expose the array under `data`.
      const data = body.data as unknown[] | undefined;
      expect(Array.isArray(data), "expected `data[]` array on paginated response").toBe(true);
      if (expected?.page !== undefined) expect(body.page).toBe(expected.page);
      if (expected?.limit !== undefined) expect(body.limit).toBe(expected.limit);
      if (expected?.total !== undefined) expect(body.total).toBe(expected.total);
      if (expected?.hasNext !== undefined) expect(body.hasNext).toBe(expected.hasNext);
      if (expected?.hasPrev !== undefined) expect(body.hasPrev).toBe(expected.hasPrev);
      return assertion;
    },

    hasError(matcher) {
      const body = getBody();
      // ErrorContract.message is canonical; legacy body.error preserved as fallback.
      const errorField = (body.message ?? body.error) as string | undefined;
      expect(errorField, "expected body.message (or body.error) to be set").toBeDefined();
      if (typeof matcher === "string") {
        expect(errorField).toBe(matcher);
      } else {
        expect(errorField).toMatch(matcher);
      }
      return assertion;
    },

    hasMeta(key, value) {
      const body = getBody();
      // sendControllerResponse flattens `meta` to top-level — so we check
      // both the flat shape (common case) and the nested one (edge cases
      // where a plugin wrote meta without the flattener).
      const flat = body[key];
      const nested = (body.meta as Record<string, unknown> | undefined)?.[key];
      const resolved = flat !== undefined ? flat : nested;
      expect(resolved, `expected meta.${key} on body`).toBeDefined();
      if (value !== undefined) expect(resolved).toEqual(value);
      return assertion;
    },
  };

  return assertion;
}
