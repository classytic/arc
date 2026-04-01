/**
 * ArcDynamicLoader Tests
 *
 * Verifies JSON schema → ResourceDefinition pipeline:
 * - Schema validation (malformed input rejected)
 * - Permission presets and fine-grained maps
 * - Field rules → schemaOptions.fieldRules for MCP
 * - QueryParser wiring (filterable, sortable → MCP auto-derive)
 * - MCP tool generation from dynamically loaded resources
 */

import { describe, expect, it, vi } from "vitest";
import {
  ArcDynamicLoader,
  type ArcArchitectureSchema,
} from "../../src/dynamic/ArcDynamicLoader.js";
import type { DataAdapter } from "../../src/adapters/interface.js";
import { resourceToTools } from "../../src/integrations/mcp/resourceToTools.js";

// ============================================================================
// Helpers
// ============================================================================

function mockAdapter(): DataAdapter {
  return {
    repository: {
      getAll: vi.fn().mockResolvedValue({ docs: [], total: 0, page: 1, limit: 20, pages: 0 }),
      getById: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ _id: "1" }),
      update: vi.fn().mockResolvedValue({ _id: "1" }),
      delete: vi.fn().mockResolvedValue({ success: true }),
    },
    type: "custom",
    name: "mock",
  };
}

function createLoader() {
  const resolvedNames: string[] = [];
  const loader = new ArcDynamicLoader({
    adapterResolver: (name, _pattern) => {
      resolvedNames.push(name);
      return mockAdapter();
    },
  });
  return { loader, resolvedNames };
}

// ============================================================================
// Schema Validation
// ============================================================================

describe("ArcDynamicLoader — schema validation", () => {
  const { loader } = createLoader();

  it("throws on missing app name", () => {
    expect(() => loader.load({ app: "", resources: [{ name: "x", permissions: "publicRead" }] })).toThrow("'app' name is required");
  });

  it("throws on empty resources array", () => {
    expect(() => loader.load({ app: "test", resources: [] })).toThrow("non-empty array");
  });

  it("throws on resource without name", () => {
    expect(() => loader.load({ app: "test", resources: [{ name: "", permissions: "publicRead" }] })).toThrow("must have a 'name'");
  });

  it("throws on resource without permissions", () => {
    expect(() => loader.load({ app: "test", resources: [{ name: "x" } as any] })).toThrow("must have 'permissions'");
  });

  it("throws on invalid field type", () => {
    expect(() =>
      loader.load({
        app: "test",
        resources: [
          {
            name: "x",
            permissions: "publicRead",
            fields: { bad: { type: "invalid" as any } },
          },
        ],
      }),
    ).toThrow('invalid type "invalid"');
  });
});

// ============================================================================
// Permission Presets
// ============================================================================

describe("ArcDynamicLoader — permission presets", () => {
  const presets = [
    "publicRead",
    "publicReadAdminWrite",
    "authenticated",
    "adminOnly",
    "ownerWithAdminBypass",
    "fullPublic",
    "readOnly",
  ] as const;

  for (const preset of presets) {
    it(`resolves "${preset}" preset`, () => {
      const { loader } = createLoader();
      const [resource] = loader.load({
        app: "test",
        resources: [{ name: "item", permissions: preset }],
      });
      expect(resource.permissions).toBeDefined();
      expect(resource.name).toBe("item");
    });
  }

  it("throws on unknown preset without permissionResolver", () => {
    const loader = new ArcDynamicLoader({
      adapterResolver: () => mockAdapter(),
    });
    expect(() =>
      loader.load({ app: "test", resources: [{ name: "x", permissions: "custom" as any }] }),
    ).toThrow('Unknown permission preset: "custom"');
  });

  it("uses permissionResolver for custom presets", () => {
    const customCheck = vi.fn().mockReturnValue(true);
    const loader = new ArcDynamicLoader({
      adapterResolver: () => mockAdapter(),
      permissionResolver: (policy) => {
        if (policy === "custom") return customCheck;
        throw new Error("Unknown");
      },
    });
    const [resource] = loader.load({
      app: "test",
      resources: [{ name: "x", permissions: "custom" as any }],
    });
    expect(resource.permissions).toBe(customCheck);
  });
});

// ============================================================================
// Fine-Grained Permissions
// ============================================================================

describe("ArcDynamicLoader — fine-grained permissions", () => {
  it("maps fine-grained permission object", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "project",
          permissions: {
            list: "public",
            get: "public",
            create: "admin",
            update: "owner",
            delete: "admin",
          },
        },
      ],
    });
    const perms = resource.permissions as Record<string, unknown>;
    expect(perms.list).toBeDefined();
    expect(perms.get).toBeDefined();
    expect(perms.create).toBeDefined();
    expect(perms.update).toBeDefined();
    expect(perms.delete).toBeDefined();
  });

  it("handles partial permission map (only list + get)", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "report",
          permissions: { list: "auth", get: "auth" },
        },
      ],
    });
    const perms = resource.permissions as Record<string, unknown>;
    expect(perms.list).toBeDefined();
    expect(perms.get).toBeDefined();
    expect(perms.create).toBeUndefined();
    expect(perms.update).toBeUndefined();
    expect(perms.delete).toBeUndefined();
  });
});

// ============================================================================
// Field Rules → schemaOptions
// ============================================================================

describe("ArcDynamicLoader — fields → schemaOptions", () => {
  it("converts shorthand field types to fieldRules", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "note",
          permissions: "publicRead",
          fields: {
            title: "string",
            count: "number",
            active: "boolean",
          },
        },
      ],
    });
    const rules = resource.schemaOptions?.fieldRules as Record<string, { type: string }>;
    expect(rules.title).toEqual({ type: "string" });
    expect(rules.count).toEqual({ type: "number" });
    expect(rules.active).toEqual({ type: "boolean" });
  });

  it("preserves full field definitions", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "product",
          permissions: "publicRead",
          fields: {
            name: { type: "string", required: true, maxLength: 200, description: "Product name" },
            price: { type: "number", required: true, min: 0 },
            category: { type: "string", enum: ["a", "b", "c"] },
            createdAt: { type: "date", systemManaged: true },
          },
        },
      ],
    });
    const rules = resource.schemaOptions?.fieldRules as Record<string, any>;
    expect(rules.name).toEqual({ type: "string", required: true, maxLength: 200, description: "Product name" });
    expect(rules.price).toEqual({ type: "number", required: true, min: 0 });
    expect(rules.category.enum).toEqual(["a", "b", "c"]);
    expect(rules.createdAt.systemManaged).toBe(true);
  });

  it("sets filterableFields in schemaOptions", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "task",
          permissions: "publicRead",
          fields: { status: "string", priority: "string" },
          filterable: ["status", "priority"],
        },
      ],
    });
    expect(resource.schemaOptions?.filterableFields).toEqual(["status", "priority"]);
  });

  it("skips schemaOptions when no fields defined", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [{ name: "simple", permissions: "publicRead" }],
    });
    // defineResource defaults schemaOptions to {} — no fieldRules means empty
    expect(resource.schemaOptions?.fieldRules).toBeUndefined();
  });
});

// ============================================================================
// QueryParser Wiring
// ============================================================================

describe("ArcDynamicLoader — queryParser wiring", () => {
  it("creates ArcQueryParser with filterable + sortable fields", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "job",
          permissions: "publicRead",
          fields: { status: "string", salary: "number" },
          filterable: ["status"],
          sortable: ["salary", "createdAt"],
        },
      ],
    });
    expect(resource.queryParser).toBeDefined();
    expect(resource.queryParser!.allowedFilterFields).toEqual(["status"]);
    expect(resource.queryParser!.allowedSortFields).toEqual(["salary", "createdAt"]);
  });

  it("skips queryParser when no filterable/sortable", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [{ name: "log", permissions: "readOnly" }],
    });
    expect(resource.queryParser).toBeUndefined();
  });

  it("queryParser enforces filter whitelist", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "event",
          permissions: "publicRead",
          filterable: ["type"],
        },
      ],
    });
    const parsed = resource.queryParser!.parse({ type: "click", secret: "hidden" });
    expect(parsed.filters).toHaveProperty("type", "click");
    expect(parsed.filters).not.toHaveProperty("secret");
  });
});

// ============================================================================
// Resource Config
// ============================================================================

describe("ArcDynamicLoader — resource config", () => {
  it("passes displayName and prefix", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "org-profile",
          displayName: "Organization Profile",
          prefix: "/orgs/profile",
          permissions: "authenticated",
        },
      ],
    });
    expect(resource.displayName).toBe("Organization Profile");
    expect(resource.prefix).toBe("/orgs/profile");
  });

  it("passes disabledRoutes", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "audit-log",
          permissions: "readOnly",
          disabledRoutes: ["create", "update", "delete"],
        },
      ],
    });
    expect(resource.disabledRoutes).toEqual(["create", "update", "delete"]);
  });

  it("resolves adapter via adapterResolver with pattern", () => {
    const patterns: string[] = [];
    const loader = new ArcDynamicLoader({
      adapterResolver: (_name, pattern) => {
        patterns.push(pattern ?? "default");
        return mockAdapter();
      },
    });
    loader.load({
      app: "test",
      resources: [
        { name: "user", adapterPattern: "postgres", permissions: "authenticated" },
        { name: "cache", adapterPattern: "redis", permissions: "adminOnly" },
      ],
    });
    expect(patterns).toEqual(["postgres", "redis"]);
  });

  it("applies presets", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        { name: "doc", permissions: "publicRead", presets: ["softDelete", "bulk"] },
      ],
    });
    expect(resource._appliedPresets).toContain("softDelete");
    expect(resource._appliedPresets).toContain("bulk");
  });
});

// ============================================================================
// MCP Integration — full chain
// ============================================================================

describe("ArcDynamicLoader → MCP tool generation", () => {
  it("generates MCP tools with correct field schemas from AAS", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "store",
      resources: [
        {
          name: "product",
          permissions: "publicRead",
          fields: {
            name: { type: "string", required: true, description: "Product name" },
            price: { type: "number", required: true, min: 0, description: "Price in USD" },
            category: { type: "string", enum: ["electronics", "books"], description: "Category" },
            inStock: { type: "boolean", description: "In stock?" },
            createdAt: { type: "date", systemManaged: true },
          },
          filterable: ["category", "inStock"],
          sortable: ["name", "price", "createdAt"],
        },
      ],
    });

    const tools = resourceToTools(resource);

    // 5 CRUD tools
    expect(tools.map((t) => t.name)).toEqual([
      "list_products", "get_product", "create_product", "update_product", "delete_product",
    ]);

    // List tool has filterable fields
    const listTool = tools.find((t) => t.name === "list_products")!;
    expect(listTool.inputSchema).toHaveProperty("category");
    expect(listTool.inputSchema).toHaveProperty("inStock");
    expect(listTool.inputSchema).not.toHaveProperty("price"); // not filterable
    expect(listTool.description).toContain("Filterable fields");
    expect(listTool.description).toContain("Sortable fields");

    // Create tool has required fields, excludes systemManaged
    const createTool = tools.find((t) => t.name === "create_product")!;
    expect(createTool.inputSchema).toHaveProperty("name");
    expect(createTool.inputSchema).toHaveProperty("price");
    expect(createTool.inputSchema).not.toHaveProperty("createdAt");
  });

  it("generates tools with disabledRoutes respected", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [
        {
          name: "log",
          permissions: "readOnly",
          fields: { message: "string", level: "string" },
          filterable: ["level"],
          disabledRoutes: ["create", "update", "delete"],
        },
      ],
    });

    const tools = resourceToTools(resource);
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_logs");
    expect(names).toContain("get_log");
    expect(names).not.toContain("create_log");
    expect(names).not.toContain("update_log");
    expect(names).not.toContain("delete_log");
  });

  it("works with minimal schema (no fields, no filters)", () => {
    const { loader } = createLoader();
    const [resource] = loader.load({
      app: "test",
      resources: [{ name: "ping", permissions: "fullPublic" }],
    });

    const tools = resourceToTools(resource);
    expect(tools).toHaveLength(5);
    expect(tools[0]!.name).toBe("list_pings");
  });
});

// ============================================================================
// Multiple Resources
// ============================================================================

describe("ArcDynamicLoader — multiple resources", () => {
  it("loads multiple resources with different configs", () => {
    const { loader, resolvedNames } = createLoader();
    const resources = loader.load({
      app: "crm",
      resources: [
        { name: "contact", permissions: "authenticated", fields: { email: "string" }, filterable: ["email"] },
        { name: "deal", permissions: { list: "auth", create: "admin", delete: "admin" }, presets: ["softDelete"] },
        { name: "report", permissions: "readOnly", disabledRoutes: ["create", "update", "delete"] },
      ],
    });

    expect(resources).toHaveLength(3);
    expect(resolvedNames).toEqual(["contact", "deal", "report"]);
    expect(resources[0]!.name).toBe("contact");
    expect(resources[1]!.name).toBe("deal");
    expect(resources[2]!.name).toBe("report");
    expect(resources[0]!.queryParser).toBeDefined();
    expect(resources[1]!._appliedPresets).toContain("softDelete");
    expect(resources[2]!.disabledRoutes).toEqual(["create", "update", "delete"]);
  });
});
