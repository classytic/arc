/**
 * loadResources() Tests
 *
 * Verifies auto-discovery of resource files from a directory.
 * Creates temporary resource files on disk, loads them, and confirms
 * they integrate correctly with createApp.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createMongooseAdapter } from "@classytic/mongokit/adapter";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BaseController } from "../../src/core/BaseController.js";
import { defineResource } from "../../src/core/defineResource.js";
import { createApp } from "../../src/factory/createApp.js";
import { loadResources } from "../../src/factory/loadResources.js";
import { allowPublic } from "../../src/permissions/index.js";
import {
  createMockModel,
  createMockRepository,
  setupTestDatabase,
  teardownTestDatabase,
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
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
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
    writeFileSync(join(FIXTURE_DIR, "bad.resource.mjs"), "export default { notAResource: true };");
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

  // ── Module evaluation errors: single attempt, no double-execution ──

  it("module that throws during evaluation is imported exactly once", async () => {
    // Isolated dir — not inside FIXTURE_DIR so it doesn't pollute other tests
    const throwDir = join(import.meta.dirname, "__fixtures_throw__");
    const {
      mkdirSync: mk,
      writeFileSync: wf,
      rmSync: rm,
      existsSync: ex,
    } = await import("node:fs");

    // Clean up from any previous run
    if (ex(throwDir)) rm(throwDir, { recursive: true, force: true });
    mk(throwDir, { recursive: true });

    wf(
      join(throwDir, "boom.resource.mjs"),
      `
      globalThis.__boomLoadCount = (globalThis.__boomLoadCount || 0) + 1;
      throw new Error('intentional evaluation error');
      `,
    );

    (globalThis as any).__boomLoadCount = 0;
    const resources = await loadResources(throwDir);
    expect(resources.length).toBe(0);
    // Must be exactly 1 — not retried, not 0 (skipped)
    expect((globalThis as any).__boomLoadCount).toBe(1);

    // Clean up
    rm(throwDir, { recursive: true, force: true });
  });

  // ── Error scenarios with isolated tmp dirs ──

  it("file with missing dependency gives actionable .js hint", async () => {
    const tmpDir = join(import.meta.dirname, "__fixtures_missing_dep__");
    const {
      mkdirSync: mk,
      writeFileSync: wf,
      rmSync: rm,
      existsSync: ex,
    } = await import("node:fs");
    if (ex(tmpDir)) rm(tmpDir, { recursive: true, force: true });
    mk(tmpDir, { recursive: true });

    // Resource that imports a non-existent .js file (common TS ESM pattern)
    wf(
      join(tmpDir, "broken.resource.mjs"),
      `import { something } from './nonexistent.js';\nexport default { toPlugin: () => {} };`,
    );

    const warnSpy = vi.fn();
    const resources = await loadResources(tmpDir, { logger: { warn: warnSpy } });
    expect(resources.length).toBe(0);

    // Should warn with .js hint
    const warnings = warnSpy.mock.calls.flat().join("\n");
    expect(warnings).toContain("failed to import");
    rm(tmpDir, { recursive: true, force: true });
  });

  it("empty resource file (no exports) is skipped", async () => {
    const tmpDir = join(import.meta.dirname, "__fixtures_empty__");
    const {
      mkdirSync: mk,
      writeFileSync: wf,
      rmSync: rm,
      existsSync: ex,
    } = await import("node:fs");
    if (ex(tmpDir)) rm(tmpDir, { recursive: true, force: true });
    mk(tmpDir, { recursive: true });

    wf(join(tmpDir, "empty.resource.mjs"), "// empty file\n");

    const resources = await loadResources(tmpDir);
    expect(resources.length).toBe(0);
    rm(tmpDir, { recursive: true, force: true });
  });

  it("resource exporting named 'resource' instead of default works", async () => {
    const tmpDir = join(import.meta.dirname, "__fixtures_named__");
    const {
      mkdirSync: mk,
      writeFileSync: wf,
      rmSync: rm,
      existsSync: ex,
    } = await import("node:fs");
    if (ex(tmpDir)) rm(tmpDir, { recursive: true, force: true });
    mk(tmpDir, { recursive: true });

    wf(
      join(tmpDir, "named.resource.mjs"),
      `export const resource = { name: 'named', toPlugin: () => ({}) };`,
    );

    const resources = await loadResources(tmpDir);
    expect(resources.length).toBe(1);
    expect((resources[0] as { name: string }).name).toBe("named");
    rm(tmpDir, { recursive: true, force: true });
  });

  it("deeply nested resources discovered", async () => {
    const tmpDir = join(import.meta.dirname, "__fixtures_deep__");
    const {
      mkdirSync: mk,
      writeFileSync: wf,
      rmSync: rm,
      existsSync: ex,
    } = await import("node:fs");
    if (ex(tmpDir)) rm(tmpDir, { recursive: true, force: true });
    mk(join(tmpDir, "a", "b", "c"), { recursive: true });

    wf(
      join(tmpDir, "a", "b", "c", "deep.resource.mjs"),
      `export default { name: 'deep', toPlugin: () => ({}) };`,
    );

    const resources = await loadResources(tmpDir);
    expect(resources.length).toBe(1);
    expect((resources[0] as { name: string }).name).toBe("deep");
    rm(tmpDir, { recursive: true, force: true });
  });

  it("multiple extensions discovered (.mjs, .js)", async () => {
    const tmpDir = join(import.meta.dirname, "__fixtures_exts__");
    const {
      mkdirSync: mk,
      writeFileSync: wf,
      rmSync: rm,
      existsSync: ex,
    } = await import("node:fs");
    if (ex(tmpDir)) rm(tmpDir, { recursive: true, force: true });
    mk(tmpDir, { recursive: true });

    wf(join(tmpDir, "a.resource.mjs"), `export default { name: 'a', toPlugin: () => ({}) };`);
    wf(join(tmpDir, "b.resource.js"), `export default { name: 'b', toPlugin: () => ({}) };`);

    const resources = await loadResources(tmpDir);
    expect(resources.length).toBe(2);
    const names = resources.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["a", "b"]);
    rm(tmpDir, { recursive: true, force: true });
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
    expect(productList.json()).toHaveProperty("data");

    const orderList = await app.inject({ method: "GET", url: "/orders" });
    expect(orderList.statusCode).toBe(200);
    expect(orderList.json()).toHaveProperty("data");

    // Full CRUD lifecycle
    const created = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: "Auto-Discovered Widget" },
    });
    expect(created.statusCode).toBe(201);

    const id = created.json()._id;

    const fetched = await app.inject({ method: "GET", url: `/products/${id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().name).toBe("Auto-Discovered Widget");

    const updated = await app.inject({
      method: "PATCH",
      url: `/products/${id}`,
      payload: { name: "Updated Widget" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe("Updated Widget");

    const deleted = await app.inject({ method: "DELETE", url: `/products/${id}` });
    expect(deleted.statusCode).toBe(200);

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
        list: allowPublic(),
        get: allowPublic(),
        create: allowPublic(),
        update: allowPublic(),
        delete: allowPublic(),
      },
    });

    let pluginsCalled = false;

    const app = await createApp({
      preset: "testing",
      auth: false,
      resources: [...discovered, taskResource],
      plugins: async () => {
        pluginsCalled = true;
      },
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
