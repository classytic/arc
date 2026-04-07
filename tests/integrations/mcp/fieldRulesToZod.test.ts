import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldRulesToZod } from "../../../src/integrations/mcp/fieldRulesToZod.js";

describe("fieldRulesToZod", () => {
  const rules = {
    name: { type: "string", required: true, maxLength: 200, description: "Product name" },
    price: { type: "number", required: true, min: 0, description: "Price in USD" },
    category: { type: "string", enum: ["electronics", "books", "other"], description: "Category" },
    isActive: { type: "boolean" },
    tags: { type: "array" },
    meta: { type: "object" },
    createdAt: { type: "date", systemManaged: true },
    secret: { type: "string", hidden: true },
    slug: { type: "string", immutable: true },
  };

  describe("create mode", () => {
    it("returns flat shape (not z.object)", () => {
      const shape = fieldRulesToZod(rules, { mode: "create" });
      expect(shape).toBeDefined();
      expect(typeof shape).toBe("object");
      // Should not be a ZodObject — just a plain Record
      expect(shape).not.toBeInstanceOf(z.ZodObject);
    });

    it("includes required and optional fields", () => {
      const shape = fieldRulesToZod(rules, { mode: "create" });
      expect(shape.name).toBeDefined();
      expect(shape.price).toBeDefined();
      expect(shape.category).toBeDefined();
      expect(shape.isActive).toBeDefined();
    });

    it("excludes systemManaged and hidden fields", () => {
      const shape = fieldRulesToZod(rules, { mode: "create" });
      expect(shape.createdAt).toBeUndefined();
      expect(shape.secret).toBeUndefined();
    });

    it("excludes readonly fields", () => {
      const shape = fieldRulesToZod(rules, { mode: "create", readonlyFields: ["slug"] });
      expect(shape.slug).toBeUndefined();
    });

    it("excludes extra hidden fields", () => {
      const shape = fieldRulesToZod(rules, { mode: "create", extraHideFields: ["meta"] });
      expect(shape.meta).toBeUndefined();
    });

    it("validates required fields", () => {
      const shape = fieldRulesToZod(rules, { mode: "create" });
      const schema = z.object(shape);
      expect(() => schema.parse({ price: 10 })).toThrow(); // name required
      expect(schema.parse({ name: "Widget", price: 10 })).toBeDefined();
    });

    it("validates string maxLength", () => {
      const shape = fieldRulesToZod(rules, { mode: "create" });
      const schema = z.object(shape);
      expect(() => schema.parse({ name: "a".repeat(201), price: 10 })).toThrow();
    });

    it("validates number min", () => {
      const shape = fieldRulesToZod(rules, { mode: "create" });
      const schema = z.object(shape);
      expect(() => schema.parse({ name: "Widget", price: -1 })).toThrow();
    });

    it("validates enum values", () => {
      const shape = fieldRulesToZod(rules, { mode: "create" });
      const schema = z.object(shape);
      expect(schema.parse({ name: "W", price: 10, category: "books" })).toBeDefined();
      expect(() => schema.parse({ name: "W", price: 10, category: "invalid" })).toThrow();
    });
  });

  describe("update mode", () => {
    it("makes all fields optional", () => {
      const shape = fieldRulesToZod(rules, { mode: "update" });
      const schema = z.object(shape);
      expect(schema.parse({})).toBeDefined(); // empty is valid
      expect(schema.parse({ name: "Updated" })).toBeDefined();
    });

    it("excludes immutable fields", () => {
      const shape = fieldRulesToZod(rules, { mode: "update" });
      expect(shape.slug).toBeUndefined();
    });
  });

  describe("list mode", () => {
    it("includes pagination fields", () => {
      const shape = fieldRulesToZod(rules, { mode: "list" });
      expect(shape.page).toBeDefined();
      expect(shape.limit).toBeDefined();
      expect(shape.sort).toBeDefined();
      expect(shape.search).toBeDefined();
    });

    it("exposes select and populate for projection + nested ref hydration", () => {
      const shape = fieldRulesToZod(rules, { mode: "list" });
      expect(shape.select).toBeDefined();
      expect(shape.populate).toBeDefined();
      // Both should be optional strings so agents can pass 'name,price' or 'supplier,category'
      const selectParsed = (shape.select as z.ZodTypeAny).safeParse("name,price");
      const populateParsed = (shape.populate as z.ZodTypeAny).safeParse("supplier,category");
      expect(selectParsed.success).toBe(true);
      expect(populateParsed.success).toBe(true);
      // And optional — empty input should validate
      expect((shape.select as z.ZodTypeAny).safeParse(undefined).success).toBe(true);
      expect((shape.populate as z.ZodTypeAny).safeParse(undefined).success).toBe(true);
    });

    it("excludes fields marked rule.hidden even when listed in filterableFields", () => {
      // Regression: list mode used to leak hidden fields because buildListShape
      // only checked `hiddenFields` array, not `rule.hidden`. Create/update
      // modes always honored `rule.hidden` — list mode now matches.
      const shape = fieldRulesToZod(rules, {
        mode: "list",
        filterableFields: ["category", "secret"],
      });
      expect(shape.category).toBeDefined();
      expect(shape.secret).toBeUndefined();
    });

    it("excludes fields marked rule.systemManaged even when listed in filterableFields", () => {
      // Regression: tenant-key fields (companyId, organizationId) are almost
      // always marked systemManaged — they must never leak into MCP list tool
      // schemas because agents could abuse them as cross-tenant filters.
      const rulesWithTenant = {
        ...rules,
        tenantId: { type: "string", systemManaged: true } as const,
      };
      const shape = fieldRulesToZod(rulesWithTenant, {
        mode: "list",
        filterableFields: ["category", "tenantId"],
      });
      expect(shape.category).toBeDefined();
      expect(shape.tenantId).toBeUndefined();
    });

    it("does not emit operator variants for hidden/systemManaged fields", () => {
      // Double-check the operator-suffix path (price_gt, price_lte, etc.)
      // also respects hidden/systemManaged.
      const rulesWithHidden = {
        ...rules,
        internalScore: { type: "number", hidden: true } as const,
      };
      const shape = fieldRulesToZod(rulesWithHidden, {
        mode: "list",
        filterableFields: ["internalScore"],
        allowedOperators: ["gt", "lt", "gte", "lte"],
      });
      expect(shape.internalScore).toBeUndefined();
      expect(shape.internalScore_gt).toBeUndefined();
      expect(shape.internalScore_lt).toBeUndefined();
      expect(shape.internalScore_gte).toBeUndefined();
      expect(shape.internalScore_lte).toBeUndefined();
    });

    it("includes filterable fields as optional", () => {
      const shape = fieldRulesToZod(rules, {
        mode: "list",
        filterableFields: ["category", "isActive"],
      });
      expect(shape.category).toBeDefined();
      expect(shape.isActive).toBeDefined();
    });

    it("excludes non-filterable fields", () => {
      const shape = fieldRulesToZod(rules, {
        mode: "list",
        filterableFields: ["category"],
      });
      expect(shape.name).toBeUndefined();
      expect(shape.price).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("returns empty shape for undefined fieldRules", () => {
      const shape = fieldRulesToZod(undefined);
      expect(Object.keys(shape)).toHaveLength(0);
    });

    it("handles empty fieldRules", () => {
      const shape = fieldRulesToZod({});
      expect(Object.keys(shape)).toHaveLength(0);
    });

    it("handles unknown field type", () => {
      const shape = fieldRulesToZod({ x: { type: "custom" } }, { mode: "create" });
      expect(shape.x).toBeDefined(); // falls back to z.string()
    });
  });
});
