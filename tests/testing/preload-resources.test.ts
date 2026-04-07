/**
 * preloadResources — Vitest helper tests
 *
 * Tests the helper that normalizes import.meta.glob results into ResourceLike[].
 */

import { describe, it, expect } from "vitest";
import {
  preloadResources,
  preloadResourcesAsync,
} from "../../src/testing/preloadResources.js";
import type { ResourceLike } from "../../src/factory/loadResources.js";

const make = (name: string): ResourceLike => ({
  name,
  toPlugin: () => () => {},
});

describe("preloadResources (eager)", () => {
  it("normalizes glob with { import: 'default' } form", () => {
    // Simulates: import.meta.glob('...', { eager: true, import: 'default' })
    const globResult = {
      "/src/resources/user.resource.ts": make("user"),
      "/src/resources/post.resource.ts": make("post"),
    };

    const resources = preloadResources(globResult);
    expect(resources).toHaveLength(2);
    // Sorted alphabetically
    expect(resources[0].name).toBe("post");
    expect(resources[1].name).toBe("user");
  });

  it("normalizes glob with full module form (default export)", () => {
    const globResult = {
      "/src/a.resource.ts": { default: make("a") },
      "/src/b.resource.ts": { default: make("b") },
    };

    const resources = preloadResources(globResult);
    expect(resources).toHaveLength(2);
    expect(resources.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("normalizes glob with full module form (named export 'resource')", () => {
    const globResult = {
      "/src/x.resource.ts": { resource: make("x") },
    };

    const resources = preloadResources(globResult);
    expect(resources[0].name).toBe("x");
  });

  it("normalizes glob with full module form (arbitrary named export)", () => {
    const globResult = {
      "/src/user.resource.ts": {
        UserModel: { name: "ExUser" }, // not a resource
        userResource: make("user"), // a resource
      },
    };

    const resources = preloadResources(globResult);
    expect(resources[0].name).toBe("user");
  });

  it("throws on file with no resource-like export", () => {
    const globResult = {
      "/src/empty.resource.ts": { someHelper: () => 42 },
    };

    expect(() => preloadResources(globResult)).toThrow(/does not export a valid resource/);
  });

  it("returns empty array for empty glob", () => {
    expect(preloadResources({})).toEqual([]);
  });

  it("preserves alphabetical order regardless of glob input order", () => {
    const globResult = {
      "/src/zebra.resource.ts": make("zebra"),
      "/src/apple.resource.ts": make("apple"),
      "/src/mango.resource.ts": make("mango"),
    };

    const resources = preloadResources(globResult);
    expect(resources.map((r) => r.name)).toEqual(["apple", "mango", "zebra"]);
  });
});

describe("preloadResourcesAsync (lazy)", () => {
  it("loads resources from lazy glob", async () => {
    const globResult = {
      "/src/user.resource.ts": async () => ({ default: make("user") }),
      "/src/post.resource.ts": async () => ({ default: make("post") }),
    };

    const resources = await preloadResourcesAsync(globResult);
    expect(resources).toHaveLength(2);
    expect(resources.map((r) => r.name)).toEqual(["post", "user"]);
  });

  it("loads resources via arbitrary named export from lazy glob", async () => {
    const globResult = {
      "/src/user.resource.ts": async () => ({ userResource: make("user") }),
    };

    const resources = await preloadResourcesAsync(globResult);
    expect(resources[0].name).toBe("user");
  });

  it("loads resources in parallel (Promise.all)", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (name: string) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { default: make(name) };
    };

    await preloadResourcesAsync({
      "/a.resource.ts": slow("a"),
      "/b.resource.ts": slow("b"),
      "/c.resource.ts": slow("c"),
    });

    expect(maxActive).toBeGreaterThan(1); // ran in parallel
  });

  it("throws on lazy file with no resource-like export", async () => {
    const globResult = {
      "/src/empty.resource.ts": async () => ({ helper: () => 42 }),
    };

    await expect(preloadResourcesAsync(globResult)).rejects.toThrow(
      /does not export a valid resource/,
    );
  });
});
