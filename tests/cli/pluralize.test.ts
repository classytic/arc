/**
 * Pluralization Utility Tests
 *
 * Verifies correct English pluralization for resource name generation.
 * The CLI uses this to produce grammatically correct route prefixes
 * and display names (e.g. /companies, not /companys).
 */

import { describe, expect, it } from "vitest";
import { pluralize } from "../../src/cli/utils/pluralize.js";

describe("pluralize", () => {
  // ============================================================================
  // Regular nouns (just add -s)
  // ============================================================================

  describe("regular nouns", () => {
    it.each([
      ["product", "products"],
      ["credential", "credentials"],
      ["notification", "notifications"],
      ["user", "users"],
      ["order", "orders"],
      ["invoice", "invoices"],
      ["role", "roles"],
      ["team", "teams"],
      ["event", "events"],
      ["comment", "comments"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // Consonant + y → -ies
  // ============================================================================

  describe("consonant + y → -ies", () => {
    it.each([
      ["company", "companies"],
      ["category", "categories"],
      ["policy", "policies"],
      ["entry", "entries"],
      ["fly", "flies"],
      ["body", "bodies"],
      ["city", "cities"],
      ["country", "countries"],
      ["currency", "currencies"],
      ["activity", "activities"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  describe("vowel + y → -ys (not -ies)", () => {
    it.each([
      ["key", "keys"],
      ["day", "days"],
      ["boy", "boys"],
      ["toy", "toys"],
      ["survey", "surveys"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // Sibilant endings: -s, -sh, -ch, -x, -z → -es
  // ============================================================================

  describe("sibilant endings → -es", () => {
    it.each([
      ["status", "statuses"],
      ["address", "addresses"],
      ["bus", "buses"],
      ["box", "boxes"],
      ["tax", "taxes"],
      ["quiz", "quizzes"],
      ["match", "matches"],
      ["batch", "batches"],
      ["wish", "wishes"],
      ["crash", "crashes"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // -f / -fe → -ves
  // ============================================================================

  describe("-f / -fe → -ves", () => {
    it.each([
      ["leaf", "leaves"],
      ["wolf", "wolves"],
      ["knife", "knives"],
      ["life", "lives"],
      ["half", "halves"],
      ["wife", "wives"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  describe("-f exceptions (keep -f, add -s)", () => {
    it.each([
      ["roof", "roofs"],
      ["chief", "chiefs"],
      ["belief", "beliefs"],
      ["cliff", "cliffs"],
      ["staff", "staffs"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // -is → -es
  // ============================================================================

  describe("-is → -es", () => {
    it.each([
      ["analysis", "analyses"],
      ["crisis", "crises"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // -us → -i
  // ============================================================================

  describe("-us → -i", () => {
    it.each([
      ["cactus", "cacti"],
      ["stimulus", "stimuli"],
      ["focus", "foci"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // -o → -es
  // ============================================================================

  describe("-o → -es (consonant + o)", () => {
    it.each([
      ["hero", "heroes"],
      ["tomato", "tomatoes"],
      ["potato", "potatoes"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  describe("-o exceptions (vowel + o → -os)", () => {
    it.each([
      ["radio", "radios"],
      ["video", "videos"],
      ["studio", "studios"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // Irregular nouns
  // ============================================================================

  describe("irregular nouns", () => {
    it.each([
      ["person", "people"],
      ["child", "children"],
      ["man", "men"],
      ["woman", "women"],
      ["mouse", "mice"],
      ["goose", "geese"],
      ["tooth", "teeth"],
      ["foot", "feet"],
      ["ox", "oxen"],
      ["datum", "data"],
      ["index", "indices"],
      ["matrix", "matrices"],
      ["vertex", "vertices"],
      ["criterion", "criteria"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // Uncountable nouns
  // ============================================================================

  describe("uncountable nouns (returned as-is)", () => {
    it.each([
      ["sheep", "sheep"],
      ["fish", "fish"],
      ["deer", "deer"],
      ["series", "series"],
      ["species", "species"],
      ["money", "money"],
      ["rice", "rice"],
      ["information", "information"],
      ["equipment", "equipment"],
      ["media", "media"],
      ["data", "data"],
    ])("%s → %s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });

  // ============================================================================
  // Capitalization preservation
  // ============================================================================

  describe("capitalization", () => {
    it("preserves capitalization for irregular words", () => {
      expect(pluralize("Person")).toBe("People");
      expect(pluralize("Child")).toBe("Children");
      expect(pluralize("Man")).toBe("Men");
    });

    it("preserves casing for regular nouns", () => {
      expect(pluralize("Product")).toBe("Products");
      expect(pluralize("Company")).toBe("Companies");
    });

    it("preserves casing for uncountables", () => {
      expect(pluralize("Sheep")).toBe("Sheep");
      expect(pluralize("Data")).toBe("Data");
    });
  });

  // ============================================================================
  // Real-world resource names (what developers actually type)
  // ============================================================================

  describe("real-world resource names", () => {
    it.each([
      ["post", "posts"],
      ["credential", "credentials"],
      ["notification", "notifications"],
      ["company", "companies"],
      ["category", "categories"],
      ["person", "people"],
      ["invoice", "invoices"],
      ["address", "addresses"],
      ["status", "statuses"],
      ["activity", "activities"],
      ["policy", "policies"],
      ["permission", "permissions"],
      ["workflow", "workflows"],
      ["webhook", "webhooks"],
      ["message", "messages"],
    ])("arc g r %s → prefix: /%s", (input, expected) => {
      expect(pluralize(input)).toBe(expected);
    });
  });
});
