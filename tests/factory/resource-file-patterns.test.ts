/**
 * Resource File Organization Patterns
 *
 * Tests loadResources with every real-world directory layout:
 * - Flat (all resources in root)
 * - Domain-grouped (commerce/, hr/, auth/)
 * - Nested subresources (commerce/product/, commerce/category/)
 * - Mixed depths
 * - Deeply nested (a/b/c/d/)
 * - Multiple resource files per domain directory
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadResources } from "../../src/factory/loadResources.js";

const TMP = join(import.meta.dirname, "__tmp_patterns__");

/** Write a minimal valid resource file */
function writeResource(dir: string, filename: string, name: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    `export default { name: '${name}', toPlugin: () => ({}) };`,
  );
}

beforeAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

// ============================================================================
// Pattern 1: Flat — all resources in one directory
// ============================================================================

describe("Pattern: flat (all in root)", () => {
  const dir = join(TMP, "flat");

  beforeAll(() => {
    writeResource(dir, "product.resource.mjs", "product");
    writeResource(dir, "order.resource.mjs", "order");
    writeResource(dir, "user.resource.mjs", "user");
  });

  it("discovers all 3 resources", async () => {
    const res = await loadResources(dir);
    expect(res.length).toBe(3);
  });

  it("returns alphabetical order", async () => {
    const res = await loadResources(dir);
    const names = res.map((r) => (r as { name: string }).name);
    expect(names).toEqual(["order", "product", "user"]);
  });
});

// ============================================================================
// Pattern 2: Domain-grouped — commerce/, hr/, auth/
// ============================================================================

describe("Pattern: domain-grouped", () => {
  const dir = join(TMP, "domain");

  beforeAll(() => {
    writeResource(join(dir, "commerce"), "product.resource.mjs", "product");
    writeResource(join(dir, "commerce"), "category.resource.mjs", "category");
    writeResource(join(dir, "hr"), "employee.resource.mjs", "employee");
    writeResource(join(dir, "auth"), "user.resource.mjs", "user");
  });

  it("discovers all 4 across domains", async () => {
    const res = await loadResources(dir);
    expect(res.length).toBe(4);
  });

  it("include filters by name not path", async () => {
    const res = await loadResources(dir, { include: ["product", "user"] });
    expect(res.length).toBe(2);
    const names = res.map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["product", "user"]);
  });

  it("exclude removes by name", async () => {
    const res = await loadResources(dir, { exclude: ["employee"] });
    expect(res.length).toBe(3);
  });

  it("can load single domain via path", async () => {
    const res = await loadResources(join(dir, "commerce"));
    expect(res.length).toBe(2);
  });
});

// ============================================================================
// Pattern 3: Nested subresources — commerce/product/product.resource.mjs
// ============================================================================

describe("Pattern: nested subresources", () => {
  const dir = join(TMP, "nested");

  beforeAll(() => {
    writeResource(join(dir, "commerce", "product"), "product.resource.mjs", "product");
    writeResource(join(dir, "commerce", "category"), "category.resource.mjs", "category");
    writeResource(join(dir, "commerce", "order"), "order.resource.mjs", "order");
    writeResource(join(dir, "hr", "employee"), "employee.resource.mjs", "employee");
    writeResource(join(dir, "hr", "department"), "department.resource.mjs", "department");
  });

  it("discovers all 5 nested resources", async () => {
    const res = await loadResources(dir);
    expect(res.length).toBe(5);
  });

  it("non-recursive only gets root (none here)", async () => {
    const res = await loadResources(dir, { recursive: false });
    expect(res.length).toBe(0);
  });

  it("loading a subdomain works", async () => {
    const res = await loadResources(join(dir, "commerce"));
    expect(res.length).toBe(3);
  });

  it("loading deepest level returns single resource", async () => {
    const res = await loadResources(join(dir, "commerce", "product"));
    expect(res.length).toBe(1);
    expect((res[0] as { name: string }).name).toBe("product");
  });
});

// ============================================================================
// Pattern 4: Mixed depths — some flat, some nested
// ============================================================================

describe("Pattern: mixed depths", () => {
  const dir = join(TMP, "mixed");

  beforeAll(() => {
    // Root-level resource
    writeResource(dir, "config.resource.mjs", "config");
    // One level deep
    writeResource(join(dir, "billing"), "invoice.resource.mjs", "invoice");
    // Two levels deep
    writeResource(join(dir, "billing", "payment"), "payment.resource.mjs", "payment");
    // Three levels deep
    writeResource(join(dir, "platform", "admin", "audit"), "audit-log.resource.mjs", "audit-log");
  });

  it("discovers all 4 at different depths", async () => {
    const res = await loadResources(dir);
    expect(res.length).toBe(4);
  });

  it("non-recursive only gets root level", async () => {
    const res = await loadResources(dir, { recursive: false });
    expect(res.length).toBe(1);
    expect((res[0] as { name: string }).name).toBe("config");
  });
});

// ============================================================================
// Pattern 5: Multiple resource files per directory (microservice split)
// ============================================================================

describe("Pattern: multiple resources per directory", () => {
  const dir = join(TMP, "multi");

  beforeAll(() => {
    writeResource(join(dir, "crm"), "contact.resource.mjs", "contact");
    writeResource(join(dir, "crm"), "deal.resource.mjs", "deal");
    writeResource(join(dir, "crm"), "pipeline.resource.mjs", "pipeline");
    // Non-resource file in same dir
    writeFileSync(join(dir, "crm", "utils.mjs"), "export const x = 1;");
    // README in same dir
    writeFileSync(join(dir, "crm", "README.md"), "# CRM Resources");
  });

  it("discovers only .resource files, not utils or README", async () => {
    const res = await loadResources(dir);
    expect(res.length).toBe(3);
  });
});

// ============================================================================
// Pattern 6: Files with non-default exports and edge cases
// ============================================================================

describe("Pattern: edge cases", () => {
  const dir = join(TMP, "edge");

  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    // Valid resource
    writeResource(dir, "valid.resource.mjs", "valid");
    // File that exports toPlugin but no name
    writeFileSync(
      join(dir, "noname.resource.mjs"),
      "export default { toPlugin: () => ({}) };",
    );
    // File that exports null default
    writeFileSync(
      join(dir, "null.resource.mjs"),
      "export default null;",
    );
    // File that exports a class with toPlugin
    writeFileSync(
      join(dir, "classy.resource.mjs"),
      "class R { constructor() { this.name = 'classy'; } toPlugin() { return {}; } }\nexport default new R();",
    );
  });

  it("includes resources with and without name", async () => {
    const res = await loadResources(dir);
    // valid + noname + classy = 3 (null is skipped)
    expect(res.length).toBe(3);
  });

  it("null default export is skipped", async () => {
    const res = await loadResources(dir);
    const names = res.map((r) => (r as { name?: string }).name).filter(Boolean);
    expect(names).toContain("valid");
    expect(names).toContain("classy");
  });

  it("class instance with toPlugin() works", async () => {
    const res = await loadResources(dir);
    const classy = res.find((r) => (r as { name?: string }).name === "classy");
    expect(classy).toBeDefined();
    expect(typeof classy!.toPlugin).toBe("function");
  });

  it("exclude by name works even for nameless resources", async () => {
    const res = await loadResources(dir, { exclude: ["valid", "classy"] });
    // Only noname left (no name to match exclude, so it passes through)
    expect(res.length).toBe(1);
  });
});
