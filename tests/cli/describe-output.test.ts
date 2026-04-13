/**
 * Arc CLI - Describe Output Tests
 *
 * Tests that `arc describe` produces correct machine-readable JSON
 * with proper schema, permissions, routes, events, and stats.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describe as arcDescribe } from "../../src/cli/commands/describe.js";

// Helper to capture console output from arc describe
async function runDescribe(entryContent: string, extraArgs: string[] = []): Promise<any> {
  const tempDir = await mkdtemp(join(tmpdir(), "arc-describe-"));
  const entryPath = join(tempDir, "resources.mjs");

  await writeFile(entryPath, entryContent, "utf8");

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));

  try {
    await arcDescribe([entryPath, ...extraArgs, "--json"]);
    const raw = logs.join("\n");
    return JSON.parse(raw);
  } finally {
    console.log = originalLog;
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Minimal resource entry for testing
const MINIMAL_RESOURCE = `
function makePublic() {
  const fn = () => ({ allowed: true });
  fn._isPublic = true;
  return fn;
}

function makeRequireRoles(roles) {
  const fn = (ctx) => roles.some(r => ctx.user?.role?.includes(r));
  fn._roles = roles;
  return fn;
}

export const productResource = {
  name: 'product',
  displayName: 'Products',
  tag: 'Products',
  prefix: '/products',
  permissions: {
    list: makePublic(),
    get: makePublic(),
    create: makeRequireRoles(['admin']),
    update: makeRequireRoles(['admin']),
    delete: makeRequireRoles(['admin']),
  },
  _appliedPresets: ['softDelete'],
  routes: [],
  events: {},
  disableDefaultRoutes: false,
  _registryMeta: {},
  toPlugin() { return async function plugin() {}; },
};
`;

// Resource with events
const RESOURCE_WITH_EVENTS = `
function makePublic() {
  const fn = () => ({ allowed: true });
  fn._isPublic = true;
  return fn;
}

export const orderResource = {
  name: 'order',
  displayName: 'Orders',
  tag: 'Orders',
  prefix: '/orders',
  permissions: {
    list: makePublic(),
    get: makePublic(),
    create: makePublic(),
    update: makePublic(),
    delete: makePublic(),
  },
  _appliedPresets: [],
  routes: [
    {
      method: 'POST',
      path: '/:id/cancel',
      summary: 'Cancel an order',
      description: 'Cancels the given order',
      permissions: makePublic(),
      handler: async () => {},
    }
  ],
  events: {
    created: { description: 'When an order is created', schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] } },
    cancelled: { description: 'When an order is cancelled' },
  },
  disableDefaultRoutes: false,
  _registryMeta: {},
  toPlugin() { return async function plugin() {}; },
};
`;

// Multiple resources
const MULTI_RESOURCES = `
function makePublic() {
  const fn = () => ({ allowed: true });
  fn._isPublic = true;
  return fn;
}
function makeRequireAuth() {
  const fn = (ctx) => !!ctx.user;
  return fn;
}

export const productResource = {
  name: 'product',
  displayName: 'Products',
  tag: 'Products',
  prefix: '/products',
  permissions: { list: makePublic(), get: makePublic(), create: makePublic(), update: makePublic(), delete: makePublic() },
  _appliedPresets: ['softDelete'],
  routes: [],
  events: {},
  disableDefaultRoutes: false,
  _registryMeta: {},
  toPlugin() { return async function plugin() {}; },
};

export const categoryResource = {
  name: 'category',
  displayName: 'Categories',
  tag: 'Categories',
  prefix: '/categories',
  permissions: { list: makePublic(), get: makePublic(), create: makeRequireAuth(), update: makeRequireAuth(), delete: makeRequireAuth() },
  _appliedPresets: [],
  routes: [],
  events: {},
  disableDefaultRoutes: false,
  _registryMeta: {},
  toPlugin() { return async function plugin() {}; },
};
`;

// ============================================================================
// Schema & Structure
// ============================================================================

describe("arc describe — output schema", () => {
  it("should produce valid arc-describe/v1 schema", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    expect(output.$schema).toBe("arc-describe/v1");
    expect(output.generatedAt).toBeDefined();
    expect(output.resources).toBeInstanceOf(Array);
    expect(output.stats).toBeDefined();
  });

  it("should include generatedAt as ISO string", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    const date = new Date(output.generatedAt);
    expect(date.toISOString()).toBe(output.generatedAt);
  });
});

// ============================================================================
// Resource Description
// ============================================================================

describe("arc describe — resource details", () => {
  it("should describe resource name, display name, prefix, and tag", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    const product = output.resources[0];
    expect(product.name).toBe("product");
    expect(product.displayName).toBe("Products");
    expect(product.prefix).toBe("/products");
    expect(product.tag).toBe("Products");
  });

  it("should list applied presets", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    const product = output.resources[0];
    expect(product.presets).toEqual(["softDelete"]);
  });
});

// ============================================================================
// Permission Description
// ============================================================================

describe("arc describe — permissions", () => {
  it("should identify public permissions", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    const perms = output.resources[0].permissions;
    expect(perms.list.type).toBe("public");
    expect(perms.get.type).toBe("public");
  });

  it("should identify requireRoles permissions with roles", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    const perms = output.resources[0].permissions;
    expect(perms.create.type).toBe("requireRoles");
    expect(perms.create.roles).toEqual(["admin"]);
    expect(perms.update.type).toBe("requireRoles");
    expect(perms.delete.type).toBe("requireRoles");
  });
});

// ============================================================================
// Routes
// ============================================================================

describe("arc describe — routes", () => {
  it("should describe all 5 CRUD routes", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    const routes = output.resources[0].routes;
    expect(routes).toHaveLength(5);

    const methods = routes.map((r: any) => `${r.method} ${r.path}`);
    expect(methods).toContain("GET /products");
    expect(methods).toContain("GET /products/:id");
    expect(methods).toContain("POST /products");
    expect(methods).toContain("PATCH /products/:id");
    expect(methods).toContain("DELETE /products/:id");
  });

  it("should map operations to routes", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    const routes = output.resources[0].routes;
    const ops = routes.map((r: any) => r.operation);
    expect(ops).toEqual(["list", "get", "create", "update", "delete"]);
  });

  it("should include route-level permissions", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    const routes = output.resources[0].routes;
    const listRoute = routes.find((r: any) => r.operation === "list");
    expect(listRoute.permission.type).toBe("public");
    const createRoute = routes.find((r: any) => r.operation === "create");
    expect(createRoute.permission.type).toBe("requireRoles");
  });

  it("should include additional routes", async () => {
    const output = await runDescribe(RESOURCE_WITH_EVENTS);
    const routes = output.resources[0].routes;
    const cancelRoute = routes.find((r: any) => r.path === "/orders/:id/cancel");
    expect(cancelRoute).toBeDefined();
    expect(cancelRoute.method).toBe("POST");
    expect(cancelRoute.summary).toBe("Cancel an order");
  });
});

// ============================================================================
// Events
// ============================================================================

describe("arc describe — events", () => {
  it("should describe resource events", async () => {
    const output = await runDescribe(RESOURCE_WITH_EVENTS);
    const events = output.resources[0].events;
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("order:created");
    expect(events[0].description).toBe("When an order is created");
    expect(events[0].hasSchema).toBe(true);
    expect(events[1].name).toBe("order:cancelled");
    expect(events[1].hasSchema).toBe(false);
  });

  it("should have empty events array when no events defined", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    expect(output.resources[0].events).toEqual([]);
  });
});

// ============================================================================
// Stats
// ============================================================================

describe("arc describe — stats", () => {
  it("should count resources correctly", async () => {
    const output = await runDescribe(MULTI_RESOURCES);
    expect(output.stats.totalResources).toBe(2);
  });

  it("should count routes correctly", async () => {
    const output = await runDescribe(MULTI_RESOURCES);
    // 2 resources × 5 CRUD routes = 10
    expect(output.stats.totalRoutes).toBe(10);
  });

  it("should count events correctly", async () => {
    const output = await runDescribe(RESOURCE_WITH_EVENTS);
    expect(output.stats.totalEvents).toBe(2);
  });

  it("should track preset usage", async () => {
    const output = await runDescribe(MULTI_RESOURCES);
    expect(output.stats.presetUsage.softDelete).toBe(1);
  });

  it("should count total fields (0 when no field perms)", async () => {
    const output = await runDescribe(MINIMAL_RESOURCE);
    expect(output.stats.totalFields).toBe(0);
  });
});

// ============================================================================
// Multiple Resources
// ============================================================================

describe("arc describe — multiple resources", () => {
  it("should describe all exported resources", async () => {
    const output = await runDescribe(MULTI_RESOURCES);
    expect(output.resources).toHaveLength(2);
    const names = output.resources.map((r: any) => r.name);
    expect(names).toContain("product");
    expect(names).toContain("category");
  });
});

// ============================================================================
// Resource Array Export
// ============================================================================

describe("arc describe — array export", () => {
  it("should handle resources exported as array", async () => {
    const entry = `
function makePublic() {
  const fn = () => ({ allowed: true });
  fn._isPublic = true;
  return fn;
}

const r1 = {
  name: 'item',
  displayName: 'Items',
  tag: 'Items',
  prefix: '/items',
  permissions: { list: makePublic(), get: makePublic(), create: makePublic(), update: makePublic(), delete: makePublic() },
  _appliedPresets: [],
  routes: [],
  events: {},
  disableDefaultRoutes: false,
  _registryMeta: {},
  toPlugin() { return async function plugin() {}; },
};

export const resources = [r1];
`;
    const output = await runDescribe(entry);
    expect(output.resources).toHaveLength(1);
    expect(output.resources[0].name).toBe("item");
  });
});

// ============================================================================
// Error Handling
// ============================================================================

describe("arc describe — error handling", () => {
  it("should throw when no resources found", async () => {
    const entry = `export const notAResource = { foo: 'bar' };`;
    await expect(runDescribe(entry)).rejects.toThrow("No resource definitions found");
  });
});
