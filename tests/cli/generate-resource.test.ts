/**
 * Arc CLI - Generate Resource Tests
 *
 * Tests that `arc generate` creates the correct resource files
 * with proper naming conventions (kebab-case files, PascalCase classes).
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../src/cli/commands/generate.js";

let testRoot: string;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

beforeAll(async () => {
  testRoot = path.join(
    tmpdir(),
    `arc-cli-gen-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  try {
    await fs.rm(testRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================================================
// Full Resource Generation (TypeScript + MongoKit)
// ============================================================================

describe("arc generate resource — TypeScript + MongoKit", () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = path.join(testRoot, "gen-ts-mongokit");
    await fs.mkdir(path.join(projectDir, "src/resources"), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, "tests"), { recursive: true });

    // Write .arcrc for MongoKit + TS detection
    await fs.writeFile(
      path.join(projectDir, ".arcrc"),
      JSON.stringify({
        adapter: "mongokit",
        auth: "jwt",
        tenant: "single",
        typescript: true,
      }),
    );

    // Also create tsconfig.json for TS detection fallback
    await fs.writeFile(path.join(projectDir, "tsconfig.json"), "{}");

    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("resource", ["product"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should create resource directory", async () => {
    expect(await exists(path.join(projectDir, "src/resources/product"))).toBe(true);
  });

  it("should create model file with correct naming", async () => {
    const filePath = path.join(projectDir, "src/resources/product/product.model.ts");
    expect(await exists(filePath)).toBe(true);

    const content = await readText(filePath);
    expect(content).toContain("Product Model");
    expect(content).toContain("interface IProduct");
    expect(content).toContain("productSchema");
    expect(content).toContain("mongoose.model");
  });

  it("should create repository file with correct naming", async () => {
    const filePath = path.join(projectDir, "src/resources/product/product.repository.ts");
    expect(await exists(filePath)).toBe(true);

    const content = await readText(filePath);
    expect(content).toContain("Product Repository");
    expect(content).toContain("ProductRepository");
    expect(content).toContain("@classytic/mongokit");
    expect(content).toContain("productRepository");
  });

  it("should create resource file with defineResource", async () => {
    const filePath = path.join(projectDir, "src/resources/product/product.resource.ts");
    expect(await exists(filePath)).toBe(true);

    const content = await readText(filePath);
    expect(content).toContain("defineResource");
    expect(content).toContain("createMongooseAdapter");
    expect(content).toContain("productResource");
    expect(content).toContain("requireAuth");
    expect(content).toContain("requireRoles");
    // Should reference product files with correct import paths
    expect(content).toContain("product.model.js");
    expect(content).toContain("product.repository.js");
  });

  it("should create test file", async () => {
    const filePath = path.join(projectDir, "tests/product.test.ts");
    expect(await exists(filePath)).toBe(true);

    const content = await readText(filePath);
    expect(content).toContain("Product Resource");
    expect(content).toContain("productResource");
    expect(content).toContain("createMinimalTestApp");
    expect(content).toContain("/products");
  });
});

// ============================================================================
// Kebab-Case Resource Names
// ============================================================================

describe("arc generate resource — kebab-case naming", () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = path.join(testRoot, "gen-kebab");
    await fs.mkdir(path.join(projectDir, "src/resources"), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, "tests"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".arcrc"),
      JSON.stringify({ adapter: "mongokit", typescript: true }),
    );
    await fs.writeFile(path.join(projectDir, "tsconfig.json"), "{}");

    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("resource", ["org-profile"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should use kebab-case for directory name", async () => {
    expect(await exists(path.join(projectDir, "src/resources/org-profile"))).toBe(true);
  });

  it("should use kebab-case for file names", async () => {
    const dir = path.join(projectDir, "src/resources/org-profile");
    expect(await exists(path.join(dir, "org-profile.model.ts"))).toBe(true);
    expect(await exists(path.join(dir, "org-profile.repository.ts"))).toBe(true);
    expect(await exists(path.join(dir, "org-profile.resource.ts"))).toBe(true);
  });

  it("should use PascalCase for class names", async () => {
    const model = await readText(
      path.join(projectDir, "src/resources/org-profile/org-profile.model.ts"),
    );
    expect(model).toContain("IOrgProfile");
    expect(model).toContain("orgProfileSchema");

    const repo = await readText(
      path.join(projectDir, "src/resources/org-profile/org-profile.repository.ts"),
    );
    expect(repo).toContain("OrgProfileRepository");
    expect(repo).toContain("orgProfileRepository");
  });

  it("should use correct import paths", async () => {
    const resource = await readText(
      path.join(projectDir, "src/resources/org-profile/org-profile.resource.ts"),
    );
    expect(resource).toContain("org-profile.model.js");
    expect(resource).toContain("org-profile.repository.js");
  });
});

// ============================================================================
// Individual Component Generation
// ============================================================================

describe("arc generate — individual components", () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = path.join(testRoot, "gen-individual");
    await fs.mkdir(path.join(projectDir, "src/resources"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, ".arcrc"),
      JSON.stringify({ adapter: "mongokit", typescript: true }),
    );
    await fs.writeFile(path.join(projectDir, "tsconfig.json"), "{}");
  });

  it("should generate only model with 'model' type", async () => {
    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("model", ["invoice"]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(await exists(path.join(projectDir, "src/resources/invoice/invoice.model.ts"))).toBe(
      true,
    );
    // Should NOT create other files
    expect(await exists(path.join(projectDir, "src/resources/invoice/invoice.repository.ts"))).toBe(
      false,
    );
  });

  it("should generate only controller with 'controller' type", async () => {
    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("controller", ["payment"]);
    } finally {
      process.chdir(originalCwd);
    }

    const filePath = path.join(projectDir, "src/resources/payment/payment.controller.ts");
    expect(await exists(filePath)).toBe(true);
    const content = await readText(filePath);
    expect(content).toContain("PaymentController");
    expect(content).toContain("BaseController");
  });

  it("should generate only repository with 'repo' shorthand", async () => {
    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("repo", ["order"]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(await exists(path.join(projectDir, "src/resources/order/order.repository.ts"))).toBe(
      true,
    );
  });

  it("should generate only schemas with 'schemas' type", async () => {
    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("schemas", ["ticket"]);
    } finally {
      process.chdir(originalCwd);
    }

    const filePath = path.join(projectDir, "src/resources/ticket/ticket.schemas.ts");
    expect(await exists(filePath)).toBe(true);
    const content = await readText(filePath);
    expect(content).toContain("buildCrudSchemasFromModel");
    expect(content).toContain("fieldRules");
  });

  it("should accept 'r' shorthand for resource", async () => {
    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("r", ["category"]);
    } finally {
      process.chdir(originalCwd);
    }

    const dir = path.join(projectDir, "src/resources/category");
    expect(await exists(path.join(dir, "category.model.ts"))).toBe(true);
    expect(await exists(path.join(dir, "category.repository.ts"))).toBe(true);
    expect(await exists(path.join(dir, "category.resource.ts"))).toBe(true);
  });
});

// ============================================================================
// Error Handling
// ============================================================================

describe("arc generate — error handling", () => {
  it("should throw when type is missing", async () => {
    await expect(generate(undefined, [])).rejects.toThrow("Missing type");
  });

  it("should throw when name is missing", async () => {
    await expect(generate("resource", [])).rejects.toThrow("Missing name");
  });

  it("should throw on unknown type", async () => {
    await expect(generate("unknown", ["foo"])).rejects.toThrow("Unknown type");
  });

  it("should skip existing files on resource generation", async () => {
    const projectDir = path.join(testRoot, "gen-skip");
    await fs.mkdir(path.join(projectDir, "src/resources/existing"), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, "tests"), { recursive: true });
    await fs.writeFile(path.join(projectDir, ".arcrc"), JSON.stringify({ typescript: true }));
    await fs.writeFile(path.join(projectDir, "tsconfig.json"), "{}");

    // Pre-create a file
    const existingFile = path.join(projectDir, "src/resources/existing/existing.model.ts");
    await fs.writeFile(existingFile, "// original content");

    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("resource", ["existing"]);
    } finally {
      process.chdir(originalCwd);
    }

    // Original content should be preserved
    const content = await readText(existingFile);
    expect(content).toBe("// original content");
  });

  it("should throw when single file already exists", async () => {
    const projectDir = path.join(testRoot, "gen-exists");
    await fs.mkdir(path.join(projectDir, "src/resources/duplicate"), {
      recursive: true,
    });
    await fs.writeFile(path.join(projectDir, ".arcrc"), JSON.stringify({ typescript: true }));
    await fs.writeFile(path.join(projectDir, "tsconfig.json"), "{}");

    // Pre-create the file
    await fs.writeFile(
      path.join(projectDir, "src/resources/duplicate/duplicate.model.ts"),
      "// exists",
    );

    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await expect(generate("model", ["duplicate"])).rejects.toThrow("already exists");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// ============================================================================
// Multi-Tenant Resource Generation
// ============================================================================

describe("arc generate resource — multi-tenant config", () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = path.join(testRoot, "gen-multi-tenant");
    await fs.mkdir(path.join(projectDir, "src/resources"), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, "tests"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".arcrc"),
      JSON.stringify({
        adapter: "mongokit",
        tenant: "multi",
        typescript: true,
      }),
    );
    await fs.writeFile(path.join(projectDir, "tsconfig.json"), "{}");

    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      await generate("resource", ["project"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should generate resource with auth permissions", async () => {
    const content = await readText(
      path.join(projectDir, "src/resources/project/project.resource.ts"),
    );
    expect(content).toContain("requireAuth");
    expect(content).toContain("requireRoles");
    expect(content).toContain("defineResource");
  });
});
