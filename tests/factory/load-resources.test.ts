/**
 * loadResources() Tests
 *
 * Verifies auto-discovery of resource files from a directory.
 * Creates temporary resource files on disk, loads them, and confirms
 * they integrate correctly with createApp.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import mongoose from "mongoose";
import { loadResources } from "../../src/factory/loadResources.js";
import { createApp } from "../../src/factory/createApp.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createMongooseAdapter } from "../../src/adapters/mongoose.js";
import { BaseController } from "../../src/core/BaseController.js";
import { allowPublic } from "../../src/permissions/index.js";
import { Repository } from "@classytic/mongokit";
import {
  setupTestDatabase,
  teardownTestDatabase,
  createMockModel,
  createMockRepository,
} from "../setup.js";

// Resolve Arc root so fixture files can use absolute imports
const ARC_ROOT = resolve(import.meta.dirname, "../..");

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures_lr__");

// ── Fixture resource files use absolute paths to Arc src ──

function makeResourceFile(modelName: string, resourceName: string): string {
  return `
import mongoose from 'mongoose';
import { Repository } from '@classytic/mongokit';
import { defineResource } from '${ARC_ROOT.replace(/\\/g, "/")}/src/core/defineResource.js';
import { createMongooseAdapter } from '${ARC_ROOT.replace(/\\/g, "/")}/src/adapters/mongoose.js';
import { BaseController } from '${ARC_ROOT.replace(/\\/g, "/")}/src/core/BaseController.js';
import { allowPublic } from '${ARC_ROOT.replace(/\\/g, "/")}/src/permissions/index.js';

const S = new mongoose.Schema({ name: String, isActive: Boolean }, { timestamps: true });
const M = mongoose.models.${modelName} || mongoose.model('${modelName}', S);
const r = new Repository(M);

export default defineResource({
  name: '${resourceName}',
  adapter: createMongooseAdapter({ model: M, repository: r }),
  controller: new BaseController(r, { resourceName: '${resourceName}' }),
  permissions: { list: allowPublic(), get: allowPublic(), create: allowPublic(), update: allowPublic(), delete: allowPublic() },
});
`;
}

describe("loadResources()", () => {
  beforeAll(async () => {
    await setupTestDatabase();

    // Create fixture directory structure
    mkdirSync(join(FIXTURE_DIR, "product"), { recursive: true });
    mkdirSync(join(FIXTURE_DIR, "order"), { recursive: true });
    mkdirSync(join(FIXTURE_DIR, "utils"), { recursive: true });

    writeFileSync(
      join(FIXTURE_DIR, "product", "product.resource.mjs"),
      makeResourceFile("LRProduct", "product"),
    );
    writeFileSync(
      join(FIXTURE_DIR, "order", "order.resource.mjs"),
      makeResourceFile("LROrder", "order"),
    );
    // Not a resource file (wrong name pattern)
    writeFileSync(join(FIXTURE_DIR, "utils", "helpers.mjs"), "export const x = 1;");
    // Matches pattern but no toPlugin()
    writeFileSync(
      join(FIXTURE_DIR, "bad.resource.mjs"),
      "export default { notAResource: true };",
    );
  });

  afterAll(async () => {
    if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
    await teardownTestDatabase();
  });

  // ── Discovery ──

  it("discovers *.resource.mjs files recursively", async () => {
    const resources = await loadResources(FIXTURE_DIR);
    // product + order (2 valid), bad.resource.mjs skipped (no toPlugin)
    expect(resources.length).toBe(2);
    expect(resources.every((r) => typeof r.toPlugin === "function")).toBe(true);
  });

  it("skips files without toPlugin() export", async () => {
    const resources = await loadResources(FIXTURE_DIR);
    const names = resources.map((r) => (r as { name?: string }).name).filter(Boolean);
    expect(names).toContain("product");
    expect(names).toContain("order");
    expect(names.length).toBe(2);
  });

  it("skips non-resource files", async () => {
    const resources = await loadResources(FIXTURE_DIR);
    expect(resources.length).toBe(2); // helpers.mjs not matched
  });

  it("returns empty array for nonexistent directory", async () => {
    const resources = await loadResources("/nonexistent/path/abc123");
    expect(resources).toEqual([]);
  });

  it("returns deterministic order (alphabetical by path)", async () => {
    const resources = await loadResources(FIXTURE_DIR);
    const names = resources.map((r) => (r as { name: string }).name);
    // order/ comes before product/ alphabetically
    expect(names).toEqual(["order", "product"]);
  });

  it("supports non-recursive mode", async () => {
    // Only bad.resource.mjs in root (no toPlugin), valid ones in subdirs
    const resources = await loadResources(FIXTURE_DIR, { recursive: false });
    expect(resources.length).toBe(0);
  });

  it("supports custom suffix", async () => {
    const resources = await loadResources(FIXTURE_DIR, { suffix: ".module" });
    expect(resources.length).toBe(0);
  });

  // ── Exclude / Include ──

  it("excludes resources by name", async () => {
    const resources = await loadResources(FIXTURE_DIR, { exclude: ["order"] });
    expect(resources.length).toBe(1);
    expect((resources[0] as { name: string }).name).toBe("product");
  });

  it("includes only specified resources", async () => {
    const resources = await loadResources(FIXTURE_DIR, { include: ["order"] });
    expect(resources.length).toBe(1);
    expect((resources[0] as { name: string }).name).toBe("order");
  });

  it("include takes priority over exclude", async () => {
    const resources = await loadResources(FIXTURE_DIR, {
      include: ["product"],
      exclude: ["product"],
    });
    // include wins — product is included despite being in exclude
    expect(resources.length).toBe(1);
    expect((resources[0] as { name: string }).name).toBe("product");
  });

  it("exclude with empty array loads all", async () => {
    const resources = await loadResources(FIXTURE_DIR, { exclude: [] });
    expect(resources.length).toBe(2);
  });

  it("include with nonexistent name returns empty", async () => {
    const resources = await loadResources(FIXTURE_DIR, { include: ["nonexistent"] });
    expect(resources.length).toBe(0);
  });

  // ── Integration with createApp ──

  it("works end-to-end with createApp({ resources })", async () => {
    const resources = await loadResources(FIXTURE_DIR);

    const app = await createApp({
      preset: "testing",
      auth: false,
      resources,
    });
    await app.ready();

    // Both resources have working CRUD
    const productList = await app.inject({ method: "GET", url: "/products" });
    expect(productList.statusCode).toBe(200);
    expect(productList.json()).toHaveProperty("docs");

    const orderList = await app.inject({ method: "GET", url: "/orders" });
    expect(orderList.statusCode).toBe(200);
    expect(orderList.json()).toHaveProperty("docs");

    // Full CRUD lifecycle
    const created = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Auto-Discovered Widget" },
    });
    expect(created.statusCode).toBe(201);

    const id = created.json().data._id;

    const fetched = await app.inject({ method: "GET", url: `/products/${id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().data.name).toBe("Auto-Discovered Widget");

    const updated = await app.inject({
      method: "PATCH",
      url: `/products/${id}`,
      payload: { name: "Updated Widget" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.name).toBe("Updated Widget");

    const deleted = await app.inject({ method: "DELETE", url: `/products/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().success).toBe(true);

    await app.close();
  });

  // ── Error handling ──

  it("createApp throws descriptive error when resource registration fails", async () => {
    const badResource = {
      name: "broken",
      toPlugin: () => {
        throw new Error("adapter not configured");
      },
    };

    await expect(
      createApp({
        preset: "testing",
        auth: false,
        resources: [badResource as any],
      }),
    ).rejects.toThrow(/Resource "broken" failed to register.*adapter not configured/);
  });

  // ── Mixed usage ──

  it("loadResources + inline resources + plugins all work together", async () => {
    const discovered = await loadResources(FIXTURE_DIR);

    // Also create an inline resource
    const TaskModel = createMockModel("LRTask");
    const taskRepo = createMockRepository(TaskModel);
    const taskResource = defineResource({
      name: "task",
      adapter: createMongooseAdapter({ model: TaskModel, repository: taskRepo }),
      controller: new BaseController(taskRepo, { resourceName: "task" }),
      permissions: {
        list: allowPublic(), get: allowPublic(), create: allowPublic(),
        update: allowPublic(), delete: allowPublic(),
      },
    });

    let pluginsCalled = false;

    const app = await createApp({
      preset: "testing",
      auth: false,
      resources: [...discovered, taskResource],
      plugins: async () => { pluginsCalled = true; },
    });
    await app.ready();

    expect(pluginsCalled).toBe(true);

    // All three resources work
    expect((await app.inject({ method: "GET", url: "/products" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/orders" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/tasks" })).statusCode).toBe(200);

    await app.close();
  });
});
