/**
 * loadResources — Windows/vitest reproduction + named export support
 *
 * This test was originally written to reproduce a PR claim about loadResources
 * failing on Windows under vitest. The investigation revealed two issues:
 *
 *   1. Real bug: loadResources only checked `default` and `resource` exports.
 *      Files using `export const fooResource = defineResource(...)` were silently
 *      skipped as "no toPlugin". Fixed by scanning all named exports.
 *
 *   2. Defensive: Node ESM rejects bare Windows drive-letter paths ("D:\..." sees
 *      "d:" as URL scheme). The fallback now skips bare-path import on Windows
 *      to surface the real file:// error instead of a misleading "protocol 'd:'".
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadResources } from "../../src/factory/loadResources.js";
import { setupTestDatabase, teardownTestDatabase } from "../setup.js";

const TMP = join(import.meta.dirname, "__tmp_named_exports__");

describe("loadResources — named export discovery", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it("loads real resource files from examples/full-app/resources/ (uses export const)", async () => {
    // The example app uses `export const userResource = defineResource(...)`
    // which is the most common convention but doesn't match `default`/`resource`.
    const resourcesDir = resolve(import.meta.dirname, "../../examples/full-app/resources");
    const resources = await loadResources(resourcesDir);

    expect(resources.length).toBeGreaterThan(0);
    const names = resources.map((r) => r.name).sort();
    expect(names).toContain("user");
    expect(names).toContain("post");
  });

  it("discovers resource via default export", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, "default.resource.ts"),
      "export default { name: 'def', toPlugin: () => () => {} };\n",
    );

    const resources = await loadResources(TMP);
    const def = resources.find((r) => r.name === "def");
    expect(def).toBeDefined();
  });

  it("discovers resource via 'resource' named export", async () => {
    const dir = join(TMP, "named-resource");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "x.resource.ts"),
      "export const resource = { name: 'named-res', toPlugin: () => () => {} };\n",
    );

    const resources = await loadResources(dir);
    expect(resources.find((r) => r.name === "named-res")).toBeDefined();
  });

  it("discovers resource via arbitrary named export with toPlugin (e.g. fooResource)", async () => {
    const dir = join(TMP, "arbitrary-named");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "user.resource.ts"),
      "export const userResource = { name: 'arbitrary', toPlugin: () => () => {} };\n",
    );

    const resources = await loadResources(dir);
    expect(resources.find((r) => r.name === "arbitrary")).toBeDefined();
  });

  it("default export wins over named export when both present", async () => {
    const dir = join(TMP, "both");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "x.resource.ts"),
      `
export const userResource = { name: 'named', toPlugin: () => () => {} };
export default { name: 'default', toPlugin: () => () => {} };
`,
    );

    const resources = await loadResources(dir);
    const found = resources.find((r) => r.name === "default" || r.name === "named");
    expect(found?.name).toBe("default");
  });

  it("skips files with no resource-like exports", async () => {
    const dir = join(TMP, "no-resource");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "helpers.resource.ts"),
      "export const helper = () => 'hello';\nexport const VERSION = '1.0';\n",
    );

    const resources = await loadResources(dir, { silent: true });
    expect(resources).toHaveLength(0);
  });
});
