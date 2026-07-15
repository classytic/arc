/**
 * resolveCorsOptions — pure CORS policy unit tests (2.22)
 *
 * The policy was extracted from registerSecurityPlugins into
 * `factory/security/cors.ts` precisely so these rules test WITHOUT a
 * Fastify instance. Integration behavior (headers on real responses)
 * stays covered by cors-configuration.test.ts + cors-arc-headers.test.ts;
 * this file pins the policy decisions and the no-mutation contract.
 */

import { describe, expect, it } from "vitest";
import { resolveCorsOptions } from "../../src/factory/security/cors.js";

describe("resolveCorsOptions — pure CORS policy", () => {
  it("throws on origin:'*' + credentials:true (reflected-origin hazard)", () => {
    expect(() => resolveCorsOptions({ cors: { origin: "*", credentials: true } })).toThrow(
      /origin: '\*'.*credentials: true/s,
    );
  });

  it("allows origin:'*' with credentials:false (public token API)", () => {
    const { options } = resolveCorsOptions({ cors: { origin: "*", credentials: false } });
    expect(options.origin).toBe("*");
  });

  it("allows origin:true + credentials (explicit reflect-any opt-in)", () => {
    const { options } = resolveCorsOptions({ cors: { origin: true, credentials: true } });
    expect(options.origin).toBe(true);
  });

  it("warns in production when origin is missing OR env-derived undefined", () => {
    const missing = resolveCorsOptions({ preset: "production", cors: { credentials: true } });
    expect(missing.warnings).toHaveLength(1);
    expect(missing.warnings[0]).toContain("not explicitly configured");

    // The env-var trap: `origin: process.env.X?.split(',')` with X unset.
    const envUndefined = resolveCorsOptions({
      preset: "production",
      cors: { origin: undefined },
    });
    expect(envUndefined.warnings).toHaveLength(1);
  });

  it("does not warn when production declares an origin, or outside production", () => {
    expect(
      resolveCorsOptions({ preset: "production", cors: { origin: ["https://a.com"] } }).warnings,
    ).toHaveLength(0);
    expect(resolveCorsOptions({ cors: {} }).warnings).toHaveLength(0);
  });

  it("merges arc protocol headers into a declared allowedHeaders list (case-insensitive, no dupes)", () => {
    const { options } = resolveCorsOptions({
      cors: { allowedHeaders: ["Content-Type", "X-Organization-Id"] },
    });
    const allowed = options.allowedHeaders as string[];
    expect(allowed).toContain("x-arc-scope");
    expect(allowed).toContain("x-request-id");
    // Case-insensitive dedup: declared X-Organization-Id not re-added.
    expect(allowed.filter((h) => h.toLowerCase() === "x-organization-id")).toHaveLength(1);
  });

  it("leaves allowedHeaders unset when the host declared none (reflection mode)", () => {
    const { options } = resolveCorsOptions({ cors: {} });
    expect(options.allowedHeaders).toBeUndefined();
  });

  it("always exposes arc auth response headers — creating exposedHeaders when absent", () => {
    const { options } = resolveCorsOptions({ cors: {} });
    expect(options.exposedHeaders).toEqual(["set-auth-token"]);
  });

  it("normalizes string-form exposedHeaders and merges without dupes", () => {
    const { options } = resolveCorsOptions({
      cors: { exposedHeaders: "x-total-count, Set-Auth-Token" },
    });
    expect(options.exposedHeaders).toEqual(["x-total-count", "Set-Auth-Token"]);
  });

  it("defaults preflight maxAge to 24h; respects an explicit 0", () => {
    expect(resolveCorsOptions({ cors: {} }).options.maxAge).toBe(86_400);
    expect(resolveCorsOptions({ cors: { maxAge: 0 } }).options.maxAge).toBe(0);
  });

  it("NEVER mutates the caller's config object (arrays are copied before merging)", () => {
    const hostConfig = {
      cors: {
        allowedHeaders: ["Content-Type"],
        exposedHeaders: ["x-total-count"],
      },
    };
    resolveCorsOptions(hostConfig);
    // A config object reused across createApp calls must not accumulate
    // arc's headers on each boot.
    expect(hostConfig.cors.allowedHeaders).toEqual(["Content-Type"]);
    expect(hostConfig.cors.exposedHeaders).toEqual(["x-total-count"]);
  });
});
