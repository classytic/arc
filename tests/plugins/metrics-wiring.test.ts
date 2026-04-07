import { describe, expect, it } from "vitest";

// Metrics plugin is imported dynamically since it may have varying exports
describe("metrics plugin", () => {
  it("can be imported from src/plugins/metrics", async () => {
    const mod = await import("../../src/plugins/metrics.js");
    expect(mod).toBeDefined();
    // Should export the plugin
    expect(mod.metricsPlugin || mod.default).toBeDefined();
  });
});
