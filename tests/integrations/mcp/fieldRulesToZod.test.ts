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
