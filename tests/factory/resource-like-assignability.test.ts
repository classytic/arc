/**
 * ResourceLike assignability test
 *
 * Verifies that ResourceDefinition (from defineResource) is assignable
 * to ResourceLike (used by createApp({ resources })) without casting.
 *
 * This is the exact scenario from the bug report:
 *   const product = defineResource({ name: 'product' });
 *   createApp({ resources: [product] }); // must NOT require `as any`
 */

import { describe, it, expect } from "vitest";
import { defineResource } from "../../src/core/defineResource.js";
import type { ResourceLike } from "../../src/factory/loadResources.js";

describe("ResourceLike assignability", () => {
  it("ResourceDefinition is assignable to ResourceLike without casting", () => {
    const product = defineResource({ name: "product", disableDefaultRoutes: true });

    // This is the exact line that failed with the index signature
    const resources: ResourceLike[] = [product];

    expect(resources[0].name).toBe("product");
    expect(resources[0].prefix).toBe("/products");
    expect(resources[0].skipGlobalPrefix).toBe(false);
    expect(typeof resources[0].toPlugin).toBe("function");
  });

  it("plain object satisfies ResourceLike", () => {
    const simple: ResourceLike = {
      name: "ping",
      toPlugin: () => () => {},
    };

    const resources: ResourceLike[] = [simple];
    expect(resources[0].name).toBe("ping");
  });

  it("loadResources return type is assignable to ResourceLike[]", async () => {
    // loadResources returns Promise<ResourceLike[]> — verify the type works
    const { loadResources } = await import("../../src/factory/loadResources.js");
    // Just check the function signature compiles — no need to actually load files
    const fn: () => Promise<ResourceLike[]> = () => loadResources("/nonexistent");
    expect(typeof fn).toBe("function");
  });

  it("mixed ResourceDefinition + plain objects work together", () => {
    const product = defineResource({ name: "product", disableDefaultRoutes: true });
    const webhook: ResourceLike = {
      name: "webhook",
      prefix: "/hooks",
      skipGlobalPrefix: true,
      toPlugin: () => () => {},
    };

    // Both in the same array — no casting needed
    const resources: ResourceLike[] = [product, webhook];
    expect(resources).toHaveLength(2);
    expect(resources[0].name).toBe("product");
    expect(resources[1].skipGlobalPrefix).toBe(true);
  });
});
