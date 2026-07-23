/**
 * `preloadResources` discoverability from `@classytic/arc/factory`.
 *
 * Mentora flagged that `preloadResources` lived only under
 * `@classytic/arc/testing` — the naming nudges devs toward "unit tests
 * only", but the canonical use case (production-shaped compliance
 * smokes that scaffold `createApp` against real resources) wants it
 * next to `loadResources`. 2.17 re-exports the helper from `/factory`
 * so autocomplete + docs surface it where it's actually needed. The
 * canonical source lives in `src/factory/preloadResources.ts`;
 * `/factory` and `/testing` are just two entry points to the same
 * function.
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

  it("is identical to the @classytic/arc/testing export (single source of truth)", async () => {
    const factory = await import("../../src/factory/index.js");
    const testing = await import("../../src/testing/index.js");
    // Reference equality — both entry points point at the exact same
    // function. Drift between the two homes would silently produce two
    // implementations.
    expect(factory.preloadResources).toBe(testing.preloadResources);
    expect(factory.preloadResourcesAsync).toBe(testing.preloadResourcesAsync);
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
