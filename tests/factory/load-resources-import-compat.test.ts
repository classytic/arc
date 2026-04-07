/**
 * loadResources() — Import Compatibility Tests
 *
 * Tests that loadResources() correctly handles different import styles
 * that real-world projects use in their resource files:
 *
 * 1. Standard relative imports (./foo.js) — MUST work
 * 2. Node.js #subpath imports (package.json "imports") — MUST work
 * 3. tsconfig path aliases (@/*, ~/*) — expected to FAIL (compile-time only)
 * 4. Mixed import styles in same project — partial success
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadResources } from "../../src/factory/loadResources.js";

const TMP = join(import.meta.dirname, "__tmp_import_compat__");

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

// ── Helper: create a minimal resource file ──

function resource(name: string, extra = ""): string {
  return `${extra}
export default {
  name: '${name}',
  toPlugin: () => () => {},
};
`;
}

function helper(exportContent: string): string {
  return `${exportContent}\n`;
}

// ============================================================================
// 1. RELATIVE IMPORTS — must work
// ============================================================================

describe("loadResources — relative imports", () => {
  const dir = join(TMP, "relative");

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("resource importing ./helper.ts via .js extension works", async () => {
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "config.ts"), helper("export const DB_NAME = 'rel-test';"));
    writeFileSync(
      join(dir, "app.resource.ts"),
      resource("app", "import { DB_NAME } from './config.js';"),
    );

    const resources = await loadResources(dir);
    expect(resources).toHaveLength(1);
    expect((resources[0] as { name: string }).name).toBe("app");
  });

  it("resource importing ../shared/util.ts works", async () => {
    const shared = join(dir, "shared");
    const resources_ = join(dir, "resources");
    mkdirSync(shared, { recursive: true });
    mkdirSync(resources_, { recursive: true });

    writeFileSync(join(shared, "util.ts"), helper("export const VERSION = '1.0';"));
    writeFileSync(
      join(resources_, "api.resource.ts"),
      resource("api", "import { VERSION } from '../shared/util.js';"),
    );

    const loaded = await loadResources(resources_);
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("api");
  });

  it("resource with deeply nested relative import chain works", async () => {
    const lib = join(dir, "lib");
    mkdirSync(lib, { recursive: true });

    // chain: resource → ./helpers.js → ../lib/core.js
    writeFileSync(join(lib, "core.ts"), helper("export const CORE = true;"));
    writeFileSync(
      join(dir, "helpers.ts"),
      "import { CORE } from '../lib/core.js';\nexport const HELPER = CORE;\n",
    );
    // Fix: helpers is sibling of resource, lib is parent-level
    // Let's restructure for clarity
    const src = join(dir, "src");
    const srcLib = join(src, "lib");
    const srcResources = join(src, "resources");
    mkdirSync(srcLib, { recursive: true });
    mkdirSync(srcResources, { recursive: true });

    writeFileSync(join(srcLib, "core.ts"), helper("export const CORE_VAL = 42;"));
    writeFileSync(
      join(srcLib, "helpers.ts"),
      "import { CORE_VAL } from './core.js';\nexport const DOUBLED = CORE_VAL * 2;\n",
    );
    writeFileSync(
      join(srcResources, "calc.resource.ts"),
      resource("calc", "import { DOUBLED } from '../lib/helpers.js';"),
    );

    const loaded = await loadResources(srcResources);
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("calc");
  });

  it("resource importing .ts file directly (no .js extension) works", async () => {
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "constants.ts"), helper("export const MAX = 100;"));
    // Direct .ts import (works in vitest, not standard ESM convention)
    writeFileSync(
      join(dir, "direct.resource.ts"),
      resource("direct", "import { MAX } from './constants.ts';"),
    );

    const loaded = await loadResources(dir);
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("direct");
  });
});

// ============================================================================
// 2. NODE.JS #SUBPATH IMPORTS — must work (package.json "imports")
// ============================================================================

describe("loadResources — Node.js #subpath imports", () => {
  // Each test uses a UNIQUE directory to avoid Node.js package.json resolution caching.
  // Node caches package.json lookups per directory — reusing the same path after
  // delete+recreate causes stale cache hits in the same process.
  let testCounter = 0;
  const getDir = () => join(TMP, `subpath-${++testCounter}-${Date.now()}`);

  it("resource using # import resolves via package.json imports field", async () => {
    const dir = getDir();
    mkdirSync(join(dir, "src", "shared"), { recursive: true });
    mkdirSync(join(dir, "src", "resources"), { recursive: true });

    writeFileSync(
      join(dir, "src", "shared", "db.ts"),
      helper("export const DB_URL = 'mongodb://localhost/test';"),
    );

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "test-subpath-project",
          type: "module",
          imports: { "#shared/*": "./src/shared/*" },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(dir, "src", "resources", "user.resource.ts"),
      resource("user", "import { DB_URL } from '#shared/db.ts';"),
    );

    const loaded = await loadResources(join(dir, "src", "resources"));
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("user");
  });

  it("# import with .js extension resolves when vitest handles .js→.ts", async () => {
    // vitest/tsx loader hooks resolve .js→.ts even through # subpath imports.
    // #lib/auth.js → ./src/lib/auth.js → vitest resolves to auth.ts
    // In production (compiled dist/), .js files exist natively → also works.
    const dir = getDir();
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    mkdirSync(join(dir, "src", "resources"), { recursive: true });

    writeFileSync(
      join(dir, "src", "lib", "auth.ts"),
      helper("export const AUTH_SECRET = 'test-secret';"),
    );

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "test-subpath-js-ext",
          type: "module",
          imports: { "#lib/*": "./src/lib/*" },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(dir, "src", "resources", "auth.resource.ts"),
      resource("auth", "import { AUTH_SECRET } from '#lib/auth.js';"),
    );

    const loaded = await loadResources(join(dir, "src", "resources"));
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("auth");
  });

  it("# import with .ts extension resolves correctly", async () => {
    const dir = getDir();
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    mkdirSync(join(dir, "src", "resources"), { recursive: true });

    writeFileSync(
      join(dir, "src", "lib", "auth.ts"),
      helper("export const AUTH_SECRET = 'test-secret';"),
    );

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "test-subpath-ts-ext",
          type: "module",
          imports: { "#lib/*": "./src/lib/*" },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(dir, "src", "resources", "auth.resource.ts"),
      resource("auth", "import { AUTH_SECRET } from '#lib/auth.ts';"),
    );

    const loaded = await loadResources(join(dir, "src", "resources"));
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("auth");
  });

  it("multiple # import patterns in same project", async () => {
    const dir = getDir();
    mkdirSync(join(dir, "src", "shared"), { recursive: true });
    mkdirSync(join(dir, "src", "config"), { recursive: true });
    mkdirSync(join(dir, "src", "resources"), { recursive: true });

    writeFileSync(
      join(dir, "src", "shared", "types.ts"),
      helper("export type User = { id: string };"),
    );
    writeFileSync(join(dir, "src", "config", "env.ts"), helper("export const PORT = 3000;"));

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "test-multi-subpath",
          type: "module",
          imports: {
            "#shared/*": "./src/shared/*",
            "#config/*": "./src/config/*",
          },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(dir, "src", "resources", "profile.resource.ts"),
      resource("profile", "import type { User } from '#shared/types.ts';"),
    );
    writeFileSync(
      join(dir, "src", "resources", "settings.resource.ts"),
      resource("settings", "import { PORT } from '#config/env.ts';"),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const loaded = await loadResources(join(dir, "src", "resources"));
    warnSpy.mockRestore();

    expect(loaded).toHaveLength(2);
    const names = loaded.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["profile", "settings"]);
  });

  it("# import with compiled .js files works (production scenario)", async () => {
    // In production, .ts is compiled to .js — # imports point to dist/ with real .js files
    const dir = getDir();
    mkdirSync(join(dir, "dist", "lib"), { recursive: true });
    mkdirSync(join(dir, "dist", "resources"), { recursive: true });

    // Compiled .mjs file (production output)
    writeFileSync(join(dir, "dist", "lib", "db.mjs"), "export const DB_NAME = 'production-db';\n");

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "test-subpath-prod",
          type: "module",
          imports: { "#lib/*": "./dist/lib/*" },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(dir, "dist", "resources", "app.resource.mjs"),
      "import { DB_NAME } from '#lib/db.mjs';\nexport default { name: 'app', toPlugin: () => () => {} };\n",
    );

    const loaded = await loadResources(join(dir, "dist", "resources"));
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("app");
  });
});

// ============================================================================
// 3. TSCONFIG PATH ALIASES — expected to fail gracefully
// ============================================================================

describe("loadResources — tsconfig path aliases (expected failures)", () => {
  const dir = join(TMP, "tsconfig-aliases");

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("resource using @/ alias fails but does not crash loadResources", async () => {
    mkdirSync(dir, { recursive: true });

    // Resource using tsconfig alias — this CANNOT resolve at runtime
    writeFileSync(
      join(dir, "broken.resource.ts"),
      resource("broken", "import { something } from '@/utils/helper';"),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await loadResources(dir);
    // Should return empty — the import fails, but loadResources doesn't crash
    expect(loaded).toHaveLength(0);

    // Should log a warning about the failed import
    const failMsg = warnSpy.mock.calls.find((c) => String(c[0]).includes("failed to import"));
    expect(failMsg).toBeDefined();

    warnSpy.mockRestore();
  });

  it("resource using ~/ alias fails gracefully", async () => {
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "tilde.resource.ts"),
      resource("tilde", "import { config } from '~/config';"),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await loadResources(dir);
    expect(loaded).toHaveLength(0);

    const failMsg = warnSpy.mock.calls.find((c) => String(c[0]).includes("failed to import"));
    expect(failMsg).toBeDefined();

    warnSpy.mockRestore();
  });

  it("mix of valid relative + invalid alias: valid resources still load", async () => {
    mkdirSync(dir, { recursive: true });

    // Valid resource with relative import
    writeFileSync(join(dir, "helper.ts"), helper("export const OK = true;"));
    writeFileSync(
      join(dir, "good.resource.ts"),
      resource("good", "import { OK } from './helper.js';"),
    );

    // Invalid resource with tsconfig alias
    writeFileSync(
      join(dir, "bad.resource.ts"),
      resource("bad", "import { nope } from '@lib/nope';"),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await loadResources(dir);

    // Only the valid resource loads — bad one fails gracefully
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("good");

    // Warning logged for the failed one
    const failMsg = warnSpy.mock.calls.find((c) => String(c[0]).includes("failed to import"));
    expect(failMsg).toBeDefined();

    warnSpy.mockRestore();
  });
});

// ============================================================================
// 4. STANDALONE APP SIMULATION — realistic project structures
// ============================================================================

describe("loadResources — simulated app structures", () => {
  const dir = join(TMP, "simulated");

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("simulated app: domain-grouped resources with shared helpers", async () => {
    // Structure:
    //   src/shared/validation.ts
    //   src/resources/product/product.resource.ts (imports ../shared)
    //   src/resources/order/order.resource.ts (imports ../shared)
    const src = join(dir, "src");
    mkdirSync(join(src, "shared"), { recursive: true });
    mkdirSync(join(src, "resources", "product"), { recursive: true });
    mkdirSync(join(src, "resources", "order"), { recursive: true });

    writeFileSync(
      join(src, "shared", "validation.ts"),
      helper("export const isValid = (v: unknown) => !!v;"),
    );
    writeFileSync(
      join(src, "resources", "product", "product.resource.ts"),
      resource("product", "import { isValid } from '../../shared/validation.js';"),
    );
    writeFileSync(
      join(src, "resources", "order", "order.resource.ts"),
      resource("order", "import { isValid } from '../../shared/validation.js';"),
    );

    const loaded = await loadResources(join(src, "resources"));
    expect(loaded).toHaveLength(2);
    const names = loaded.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["order", "product"]);
  });

  it("simulated app: resource imports from sibling model file", async () => {
    // Common pattern: resource + model co-located
    //   src/resources/user/user.model.ts
    //   src/resources/user/user.resource.ts
    const userDir = join(dir, "src", "resources", "user");
    mkdirSync(userDir, { recursive: true });

    writeFileSync(
      join(userDir, "user.model.ts"),
      helper("export const UserSchema = { name: 'string' };"),
    );
    writeFileSync(
      join(userDir, "user.resource.ts"),
      resource("user", "import { UserSchema } from './user.model.js';"),
    );

    const loaded = await loadResources(join(dir, "src", "resources"));
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("user");
  });

  it("simulated app: 10 resources auto-discovered with mixed nesting", async () => {
    const base = join(dir, "resources");
    const names = [
      "account",
      "billing",
      "customer",
      "dashboard",
      "email",
      "feature",
      "gateway",
      "history",
      "invoice",
      "journal",
    ];

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      // Alternate: some flat, some nested
      const resDir = i % 2 === 0 ? base : join(base, name);
      mkdirSync(resDir, { recursive: true });
      writeFileSync(join(resDir, `${name}.resource.ts`), resource(name));
    }

    const loaded = await loadResources(base);
    expect(loaded).toHaveLength(10);
    const loadedNames = loaded.map((r) => (r as { name: string }).name).sort();
    expect(loadedNames).toEqual(names);
  });

  it("simulated app: exclude debug/test resources in production", async () => {
    const base = join(dir, "resources");
    mkdirSync(base, { recursive: true });

    writeFileSync(join(base, "product.resource.ts"), resource("product"));
    writeFileSync(join(base, "order.resource.ts"), resource("order"));
    writeFileSync(join(base, "debug.resource.ts"), resource("debug"));
    writeFileSync(join(base, "test-only.resource.ts"), resource("test-only"));

    const loaded = await loadResources(base, {
      exclude: ["debug", "test-only"],
    });
    expect(loaded).toHaveLength(2);
    const names = loaded.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["order", "product"]);
  });

  it("simulated app: include only microservice subset", async () => {
    const base = join(dir, "resources");
    mkdirSync(base, { recursive: true });

    // Full monorepo has many resources, microservice only needs a few
    for (const name of [
      "user",
      "product",
      "order",
      "payment",
      "shipping",
      "notification",
      "analytics",
    ]) {
      writeFileSync(join(base, `${name}.resource.ts`), resource(name));
    }

    // Payment service only needs these
    const loaded = await loadResources(base, {
      include: ["payment", "order"],
    });
    expect(loaded).toHaveLength(2);
    const names = loaded.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["order", "payment"]);
  });

  it("simulated app: JS-only project (no TypeScript) works", async () => {
    const base = join(dir, "resources");
    mkdirSync(base, { recursive: true });

    // Pure .mjs resources (JavaScript-only project)
    writeFileSync(
      join(base, "item.resource.mjs"),
      "export default { name: 'item', toPlugin: () => () => {} };\n",
    );
    writeFileSync(
      join(base, "store.resource.mjs"),
      "export default { name: 'store', toPlugin: () => () => {} };\n",
    );

    const loaded = await loadResources(base);
    expect(loaded).toHaveLength(2);
    const names = loaded.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["item", "store"]);
  });

  it("simulated app: .js resources (CommonJS-style named .js) work", async () => {
    const base = join(dir, "resources");
    mkdirSync(base, { recursive: true });

    writeFileSync(
      join(base, "widget.resource.js"),
      "export default { name: 'widget', toPlugin: () => () => {} };\n",
    );

    const loaded = await loadResources(base);
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("widget");
  });
});

// ============================================================================
// 5. import.meta.url SUPPORT — dev/prod parity
// ============================================================================

describe("loadResources — import.meta.url support", () => {
  const dir = join(TMP, "meta-url");

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts file:// URL and resolves to its parent directory", async () => {
    // Simulates: loadResources(import.meta.url) from a file in the resources dir
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "item.resource.ts"), resource("item"));
    writeFileSync(join(dir, "order.resource.ts"), resource("order"));

    // Simulate import.meta.url of a file inside the directory
    const fakeMetaUrl = pathToFileURL(join(dir, "index.ts")).href;

    const loaded = await loadResources(fakeMetaUrl);
    expect(loaded).toHaveLength(2);
    const names = loaded.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["item", "order"]);
  });

  it("file:// URL resolves dirname — ignores the filename itself", async () => {
    // loadResources(import.meta.url) where import.meta.url = file:///app/src/resources/app.ts
    // should scan /app/src/resources/, NOT look for app.ts as a directory
    const resourcesDir = join(dir, "src", "resources");
    mkdirSync(resourcesDir, { recursive: true });

    writeFileSync(join(resourcesDir, "user.resource.ts"), resource("user"));

    // Simulate import.meta.url pointing to a .ts file inside resources/
    const fakeMetaUrl = pathToFileURL(join(resourcesDir, "app.ts")).href;

    const loaded = await loadResources(fakeMetaUrl);
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("user");
  });

  it("file:// URL works with nested resource directories", async () => {
    const base = join(dir, "app", "resources");
    mkdirSync(join(base, "product"), { recursive: true });
    mkdirSync(join(base, "order"), { recursive: true });

    writeFileSync(join(base, "product", "product.resource.ts"), resource("product"));
    writeFileSync(join(base, "order", "order.resource.ts"), resource("order"));

    const fakeMetaUrl = pathToFileURL(join(base, "index.ts")).href;

    const loaded = await loadResources(fakeMetaUrl);
    expect(loaded).toHaveLength(2);
    const names = loaded.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["order", "product"]);
  });

  it("file:// URL works with options (exclude, include)", async () => {
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "a.resource.ts"), resource("alpha"));
    writeFileSync(join(dir, "b.resource.ts"), resource("beta"));
    writeFileSync(join(dir, "c.resource.ts"), resource("gamma"));

    const fakeMetaUrl = pathToFileURL(join(dir, "loader.ts")).href;

    const loaded = await loadResources(fakeMetaUrl, {
      include: ["alpha", "gamma"],
    });
    expect(loaded).toHaveLength(2);
    const names = loaded.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["alpha", "gamma"]);
  });

  it("plain directory path still works (backward compatible)", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.resource.ts"), resource("x"));

    // Regular path (not file://) — must still work
    const loaded = await loadResources(dir);
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { name: string }).name).toBe("x");
  });

  it("simulates dev vs prod parity with import.meta.url", async () => {
    // Dev layout:  src/resources/product.resource.ts
    // Prod layout:  dist/resources/product.resource.mjs
    // import.meta.url resolves to the correct one based on runtime
    const devDir = join(dir, "src", "resources");
    const prodDir = join(dir, "dist", "resources");
    mkdirSync(devDir, { recursive: true });
    mkdirSync(prodDir, { recursive: true });

    writeFileSync(join(devDir, "product.resource.ts"), resource("product"));
    writeFileSync(
      join(prodDir, "product.resource.mjs"),
      "export default { name: 'product', toPlugin: () => () => {} };\n",
    );

    // Dev: import.meta.url = file:///project/src/resources/index.ts
    const devUrl = pathToFileURL(join(devDir, "index.ts")).href;
    const devLoaded = await loadResources(devUrl);
    expect(devLoaded).toHaveLength(1);
    expect((devLoaded[0] as { name: string }).name).toBe("product");

    // Prod: import.meta.url = file:///project/dist/resources/index.mjs
    const prodUrl = pathToFileURL(join(prodDir, "index.mjs")).href;
    const prodLoaded = await loadResources(prodUrl);
    expect(prodLoaded).toHaveLength(1);
    expect((prodLoaded[0] as { name: string }).name).toBe("product");
  });
});
