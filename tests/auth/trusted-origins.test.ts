/**
 * Tests for the `mirrorTrustedOriginsFromCors` helper.
 */

import { describe, expect, it } from "vitest";
import { mirrorTrustedOriginsFromCors } from "../../src/auth/trustedOrigins.js";

const FRONTEND = "https://app.example.com";

describe("mirrorTrustedOriginsFromCors", () => {
  it("returns [canonicalUrl] when corsOrigins is undefined", () => {
    expect(
      mirrorTrustedOriginsFromCors({ corsOrigins: undefined, canonicalUrl: FRONTEND }),
    ).toEqual([FRONTEND]);
  });

  it("returns [canonicalUrl] when corsOrigins is false", () => {
    expect(
      mirrorTrustedOriginsFromCors({ corsOrigins: false, canonicalUrl: FRONTEND }),
    ).toEqual([FRONTEND]);
  });

  it('returns ["*"] when corsOrigins is true (wildcard)', () => {
    expect(
      mirrorTrustedOriginsFromCors({ corsOrigins: true, canonicalUrl: FRONTEND }),
    ).toEqual(["*"]);
  });

  it("merges canonicalUrl with array, deduped", () => {
    expect(
      mirrorTrustedOriginsFromCors({
        corsOrigins: ["http://localhost:3000", "http://localhost:5173"],
        canonicalUrl: FRONTEND,
      }),
    ).toEqual([FRONTEND, "http://localhost:3000", "http://localhost:5173"]);
  });

  it("dedupes when canonicalUrl is already in the array", () => {
    expect(
      mirrorTrustedOriginsFromCors({
        corsOrigins: [FRONTEND, "http://localhost:3000"],
        canonicalUrl: FRONTEND,
      }),
    ).toEqual([FRONTEND, "http://localhost:3000"]);
  });

  it("places canonicalUrl first in the result (debug-log readability)", () => {
    const result = mirrorTrustedOriginsFromCors({
      corsOrigins: ["http://b.test", "http://a.test"],
      canonicalUrl: FRONTEND,
    });
    expect(result[0]).toBe(FRONTEND);
  });

  it("handles empty array — just returns [canonicalUrl]", () => {
    expect(
      mirrorTrustedOriginsFromCors({ corsOrigins: [], canonicalUrl: FRONTEND }),
    ).toEqual([FRONTEND]);
  });
});
