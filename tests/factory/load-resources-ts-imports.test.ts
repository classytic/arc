/**
 * loadResources — TypeScript .js Extension Import Test
 *
 * Tests the real-world scenario where .ts resource files use .js extension
 * imports (standard TypeScript ESM convention):
 *   import { foo } from './foo.js'  // foo.ts exists, foo.js does not
 *
 * vitest/tsx resolve .js→.ts via loader hooks.
 * Raw Node.js requires compiled .js files (production build).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadResources } from "../../src/factory/loadResources.js";

const TMP = join(import.meta.dirname, "__tmp_ts_imports__");
const FIXTURES = resolve(import.meta.dirname, "../fixtures/resources");

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("loadResources with .ts files using .js imports", () => {
  it("discovers .ts resource that imports via .js extension (vitest resolves)", async () => {
    mkdirSync(TMP, { recursive: true });

    writeFileSync(join(TMP, "helper.ts"), `export const DB_NAME = 'test-db';\n`);

    writeFileSync(
      join(TMP, "db.resource.ts"),
      `import { DB_NAME } from './helper.js';\nexport default { name: DB_NAME, toPlugin: () => ({}) };\n`,
    );

    const resources = await loadResources(TMP);
    expect(resources.length).toBe(1);
    expect((resources[0] as { name: string }).name).toBe("test-db");
  });

  it("discovers plain .ts resource without .js imports", async () => {
    const dir = join(TMP, "plain");
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "simple.resource.ts"),
      `export default { name: 'simple', toPlugin: () => ({}) };\n`,
    );

    const resources = await loadResources(dir);
    expect(resources.length).toBe(1);
    expect((resources[0] as { name: string }).name).toBe("simple");
  });

  // ── Fixture-based tests (widget.resource.ts imports widget.model.js→.ts) ──

  it("loads fixture resource with nested .js→.ts import", async () => {
    const resources = await loadResources(FIXTURES);
    expect(resources.length).toBeGreaterThan(0);
    const widget = resources.find((r) => (r as { name: string }).name === "widget");
    expect(widget).toBeDefined();
    expect(typeof widget?.toPlugin).toBe("function");
    // Verify the nested import resolved correctly
    expect((widget as { _model: { name: string } })._model.name).toBe("WidgetModel");
  });

  it("does not log failed imports for valid fixture resources", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadResources(FIXTURES);
    const failMsg = warnSpy.mock.calls.find((c) => String(c[0]).includes("failed to import"));
    expect(failMsg).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("pathToFileURL import resolves .js→.ts in vitest", async () => {
    const file = resolve(FIXTURES, "widget/widget.resource.ts");
    const mod = await import(pathToFileURL(file).href);
    expect(mod.default?.name).toBe("widget");
    expect(mod.default?._model?.name).toBe("WidgetModel");
  });
});
