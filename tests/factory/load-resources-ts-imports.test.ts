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

import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadResources } from "../../src/factory/loadResources.js";

const TMP = join(import.meta.dirname, "__tmp_ts_imports__");

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("loadResources with .ts files using .js imports", () => {
  it("discovers .ts resource that imports via .js extension (vitest resolves)", async () => {
    mkdirSync(TMP, { recursive: true });

    // Helper module (only .ts exists, no .js)
    writeFileSync(
      join(TMP, "helper.ts"),
      `export const DB_NAME = 'test-db';\n`,
    );

    // Resource file that imports helper via .js extension (TS ESM convention)
    writeFileSync(
      join(TMP, "db.resource.ts"),
      `import { DB_NAME } from './helper.js';\nexport default { name: DB_NAME, toPlugin: () => ({}) };\n`,
    );

    const resources = await loadResources(TMP);

    // In vitest: .js→.ts resolution works via loader hooks
    // The resource should be discovered and its import resolved
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
});
