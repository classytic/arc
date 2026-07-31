/**
 * `filterResourcesForMcp` — central resolution of which resources reach
 * the MCP plugin's tool generator.
 *
 * Three intent layers (covered here):
 *   1. Per-resource `mcp: false` — local opt-out, authoritative.
 *   2. Plugin-level `expose` allowlist — default-deny.
 *   3. Plugin-level `exclude` blocklist — default-allow (drift-prone).
 *
 * Layer 1 always wins so adding a never-expose resource is a one-file
 * change in the resource module instead of a host-wide blocklist edit.
 */

import { describe, expect, it } from "vitest";
import { filterResourcesForMcp } from "../../../src/integrations/mcp/mcpPlugin.js";

type Resource = { name: string; mcp?: boolean };

const r = (name: string, mcp?: boolean): Resource => (mcp === undefined ? { name } : { name, mcp });

describe("filterResourcesForMcp", () => {
  describe("default (no plugin-level selection)", () => {
    it("returns every resource when none have opted out", () => {
      const resources = [r("a"), r("b"), r("c")];
      expect(filterResourcesForMcp(resources, {})).toEqual(resources);
    });

    it("drops resources declared with `mcp: false`", () => {
      const resources = [r("a"), r("internal", false), r("c")];
      expect(filterResourcesForMcp(resources, {}).map((x) => x.name)).toEqual(["a", "c"]);
    });

    it("treats `mcp: true` as the default-allow state", () => {
      const resources = [r("a", true), r("b"), r("c", true)];
      expect(filterResourcesForMcp(resources, {}).map((x) => x.name)).toEqual(["a", "b", "c"]);
    });
  });

  describe("`expose` allowlist", () => {
    it("returns only the allowed names", () => {
      const resources = [r("a"), r("b"), r("c")];
      expect(filterResourcesForMcp(resources, { expose: ["a", "c"] }).map((x) => x.name)).toEqual([
        "a",
        "c",
      ]);
    });

    it("local `mcp: false` overrides an explicit `expose` entry", () => {
      const resources = [r("a"), r("billing", false)];
      // Even though `billing` is in the allowlist, its local opt-out wins.
      const filtered = filterResourcesForMcp(resources, { expose: ["a", "billing"] });
      expect(filtered.map((x) => x.name)).toEqual(["a"]);
    });
  });

  describe("`exclude` blocklist", () => {
    it("removes the blocklisted names", () => {
      const resources = [r("a"), r("b"), r("c")];
      expect(filterResourcesForMcp(resources, { exclude: ["b"] }).map((x) => x.name)).toEqual([
        "a",
        "c",
      ]);
    });

    it("local `mcp: false` and `exclude` compose (both drop the resource)", () => {
      const resources = [r("a"), r("b", false), r("c")];
      expect(filterResourcesForMcp(resources, { exclude: ["c"] }).map((x) => x.name)).toEqual([
        "a",
      ]);
    });
  });

  describe("error states", () => {
    it("throws when `expose` is combined with `exclude`", () => {
      expect(() => filterResourcesForMcp([r("a")], { expose: ["a"], exclude: ["b"] })).toThrowError(
        /`expose` is default-deny/,
      );
    });
  });
});
