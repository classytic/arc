import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { canonicalUrl } from "../../src/http-cache/policy/cache-key.js";
import {
  assertPolicy,
  privateHeaders,
  publicHeaders,
} from "../../src/http-cache/policy/directives.js";
import { classifyPrivacy } from "../../src/http-cache/policy/privacy.js";
import {
  normalizeTags,
  resourceTags,
  responseTags,
  tagHeaderValue,
} from "../../src/http-cache/policy/tags.js";

const req = (headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  ({ headers, params: {}, ...extra }) as unknown as FastifyRequest;

describe("classifyPrivacy", () => {
  it.each([
    [{ authorization: "Bearer x" }, "header:authorization"],
    [{ "x-api-key": "k" }, "header:x-api-key"],
    [{ "x-organization-id": "o" }, "header:x-organization-id"],
    [{ cookie: "sid=2; theme=dark" }, "cookie:sid"],
  ])("makes %j private, naming the signal (%s) but not its value", (headers, reason) => {
    expect(classifyPrivacy(req(headers))).toEqual({ private: true, reason });
  });

  it("makes a non-public arc scope private even without a credential header", () => {
    expect(classifyPrivacy(req({}, { scope: { kind: "member" } }))).toEqual({
      private: true,
      reason: "scope:member",
    });
    expect(classifyPrivacy(req({}, { scope: { kind: "public" } }))).toEqual({ private: false });
  });

  it("lets allowlisted cookies through, and only those", () => {
    expect(
      classifyPrivacy(req({ cookie: "_ga=1; consent=y" }), { publicCookies: ["_ga", "consent"] }),
    ).toEqual({ private: false });
  });

  it("lets a host classifier add privacy but never remove it", () => {
    expect(classifyPrivacy(req(), { classify: () => false })).toEqual({
      private: true,
      reason: "classifier",
    });
    expect(classifyPrivacy(req({ authorization: "x" }), { classify: () => true })).toMatchObject({
      private: true,
    });
  });

  it("honours custom private headers, case-insensitively", () => {
    expect(classifyPrivacy(req({ "x-tenant": "t" }), { privateHeaders: ["X-Tenant"] })).toEqual({
      private: true,
      reason: "header:x-tenant",
    });
    expect(classifyPrivacy(req({ authorization: "x" }), { privateHeaders: ["X-Tenant"] })).toEqual({
      private: false,
    });
  });
});

describe("directives", () => {
  it("emits browser TTL, s-maxage and RFC 9213 CDN-Cache-Control from one policy", () => {
    expect(
      publicHeaders({ cdn: 600, browser: 60, staleWhileRevalidate: 30, staleIfError: 86_400 }),
    ).toEqual({
      "cache-control": "public, max-age=60, s-maxage=600, stale-if-error=86400",
      "cdn-cache-control": "max-age=600, stale-while-revalidate=30, stale-if-error=86400",
    });
  });

  it("can drop either CDN header", () => {
    expect(publicHeaders({ cdn: 10 }, { sMaxAge: false, cdnCacheControl: false })).toEqual({
      "cache-control": "public, max-age=0",
    });
  });

  it("floors fractional and negative values", () => {
    expect(
      publicHeaders({ cdn: 60.9, browser: -5 }, { cdnCacheControl: false })["cache-control"],
    ).toBe("public, max-age=0, s-maxage=60");
  });

  it("never lets a non-2xx be stored, and keeps it out of private caches only when it is a privacy decision", () => {
    expect(privateHeaders("status")).toEqual({ "cache-control": "no-store" });
    expect(privateHeaders("header:authorization")).toEqual({
      "cache-control": "private, no-store",
    });
    expect(privateHeaders("set-cookie")).toEqual({ "cache-control": "private, no-store" });
  });

  it.each([
    { cdn: 0 },
    { cdn: -1 },
    { cdn: Number.NaN },
    { cdn: 10, browser: -1 },
    { cdn: 10, staleIfError: Number.POSITIVE_INFINITY },
  ])("refuses %j", (policy) => {
    expect(() => assertPolicy(policy, "test")).toThrow(/httpCache test/);
  });
});

describe("tags", () => {
  it("keeps only CDN-safe tags: printable ASCII, no separator, bounded, de-duplicated", () => {
    expect(
      normalizeTags([" a ", "a", "b c", "d,e", "", 5, "x".repeat(1025), "ok", "কোর্স", "tab\tx"]),
    ).toEqual(["a", "ok"]);
  });

  it("derives <resource> and <resource>:<id>", () => {
    expect(resourceTags("course")).toEqual(["course"]);
    expect(resourceTags("course", 42)).toEqual(["course", "course:42"]);
  });

  it("derives a get reply's tags from the route id and the document, then adds the policy's own", () => {
    const tags = responseTags(
      {
        cdn: 60,
        tags: ["catalog"],
        resource: {
          name: "course",
          op: "get",
          extra: (doc) => [`org:${(doc as { org: string }).org}`],
        },
      },
      req({}, { params: { id: "c1" } }),
      { data: { org: "o9" } },
    );
    expect(tags).toEqual(["course", "course:c1", "org:o9", "catalog"]);
  });

  it("gives a list only the collection tag", () => {
    expect(
      responseTags({ cdn: 60, resource: { name: "course", op: "list" } }, req({}, { params: {} }), {
        data: [],
      }),
    ).toEqual(["course"]);
  });

  it("caps the header under 16 KB and reports how many tags were dropped", () => {
    const tags = Array.from({ length: 2000 }, (_, i) => `t${String(i).padStart(10, "0")}`);
    const { value, dropped } = tagHeaderValue(tags, ",");
    expect(value.length).toBeLessThanOrEqual(16_000);
    expect(dropped).toBeGreaterThan(0);
    expect(value.split(",").length + dropped).toBe(2000);
  });
});

describe("canonicalUrl", () => {
  it("drops tracking parameters and sorts the rest", () => {
    expect(canonicalUrl("/courses?utm_source=x&page=2&fbclid=y&a=1")).toBe("/courses?a=1&page=2");
  });
  it("leaves a canonical URL untouched and removes an all-tracking query", () => {
    expect(canonicalUrl("/courses?a=1&b=2")).toBe("/courses?a=1&b=2");
    expect(canonicalUrl("/courses?utm_medium=email")).toBe("/courses");
    expect(canonicalUrl("/courses")).toBe("/courses");
  });
  it("supports custom ignore patterns and opting out of sorting", () => {
    expect(canonicalUrl("/c?b=1&ref=x&a=2", { ignore: ["ref"], sort: false })).toBe("/c?b=1&a=2");
  });
});
