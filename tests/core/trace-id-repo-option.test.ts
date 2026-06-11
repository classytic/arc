/**
 * traceId repo-option forwarding — repo-core 0.6 made `traceId` a
 * canonical `STANDARD_REPO_OPTION_KEYS` entry (distinct from
 * `requestId`). `buildTenantRepoOptions` forwards the 32-hex W3C trace
 * id whenever the requestId plugin validated an incoming `traceparent`
 * and decorated `request.traceContext`.
 */

import { describe, expect, it } from "vitest";
import { buildTenantRepoOptions } from "../../src/core/crud/requestPipeline.js";
import type { IRequestContext } from "../../src/types/index.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function makeReq(extra: Record<string, unknown> = {}): IRequestContext {
  return { id: "req-1", user: undefined, ...extra } as unknown as IRequestContext;
}

describe("buildTenantRepoOptions trace correlation", () => {
  it("forwards traceId from a validated traceparent", () => {
    const out = buildTenantRepoOptions(
      makeReq({ traceContext: { traceparent: TRACEPARENT } }),
      false,
      undefined,
    );
    expect(out.requestId).toBe("req-1");
    expect(out.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("omits traceId when no traceContext was decorated", () => {
    const out = buildTenantRepoOptions(makeReq(), false, undefined);
    expect(out.requestId).toBe("req-1");
    expect(out).not.toHaveProperty("traceId");
  });
});
