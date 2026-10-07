/**
 * `preloadResources` discoverability from `@classytic/arc/factory`.
 *
 * Mentora flagged that `preloadResources` lived only under
 * `@classytic/arc/testing` — the naming nudges devs toward "unit tests
 * only", but the canonical use case (production-shaped compliance
 * smokes that scaffold `createApp` against real resources) wants it
 * next to `loadResources`. 2.17 re-exported the helper from `/factory`;
 * 2.43 dropped the `/testing` copy, so `/factory` is the ONE entry point.
 * The canonical source lives in `src/factory/preloadResources.ts`.
 */

import { describe, expect, it } from "vitest";

describe("@classytic/arc/factory — preloadResources re-export", () => {
  it("exposes preloadResources next to loadResources", async () => {
    const factory = await import("../../src/factory/index.js");
    expect(typeof factory.preloadResources).toBe("function");
    expect(typeof factory.preloadResourcesAsync).toBe("function");
    // Co-resident with the rest of the factory surface
    expect(typeof factory.loadResources).toBe("function");
    expect(typeof factory.createApp).toBe("function");
  });

  it("is NOT exported from @classytic/arc/testing (one home: /factory)", async () => {
    const testing: Record<string, unknown> = await import("../../src/testing/index.js");
    expect(testing.preloadResources).toBeUndefined();
    expect(testing.preloadResourcesAsync).toBeUndefined();
  });

  it("normalizes an eager-glob result identically when imported via /factory", async () => {
    const { preloadResources } = await import("../../src/factory/index.js");

    const fakeResource = {
      name: "demo",
      toPlugin: () => async () => {},
    };
    const globResult = {
      "/path/to/demo.resource.ts": fakeResource,
    };

    const resources = preloadResources(globResult);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toBe(fakeResource);
  });
});
