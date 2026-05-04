/**
 * Arc CLI - Init Scaffolding Tests
 *
 * Tests that `arc init` creates the correct file structure for all
 * configuration combinations (jwt/better-auth × single/multi-tenant).
 * Uses --skip-install to avoid npm install during tests.
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init } from "../../src/cli/commands/init.js";

// Temp directory for all init tests
let testRoot: string;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf-8"));
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

beforeAll(async () => {
  testRoot = path.join(
    tmpdir(),
    `arc-cli-init-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  // Clean up temp directory
  try {
    await fs.rm(testRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================================================
// JWT + Single Tenant (simplest setup)
// ============================================================================

describe("arc init — JWT + Single Tenant", () => {
  const projectName = "test-jwt-single";
  let projectPath: string;

  beforeAll(async () => {
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      await init({
        name: projectName,
        adapter: "mongokit",
        auth: "jwt",
        tenant: "single",
        typescript: true,
        skipInstall: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
    projectPath = path.join(testRoot, projectName);
  });

  it("should create project directory", async () => {
    expect(await exists(projectPath)).toBe(true);
  });

  it("should create core directories", async () => {
    const dirs = [
      "src",
      "src/config",
      "src/shared",
      "src/shared/presets",
      "src/plugins",
      "src/resources",
      "src/resources/example",
      "tests",
    ];
    for (const dir of dirs) {
      expect(await exists(path.join(projectPath, dir))).toBe(true);
    }
  });

  it("should create JWT-specific auth directories", async () => {
    expect(await exists(path.join(projectPath, "src/resources/user"))).toBe(true);
    expect(await exists(path.join(projectPath, "src/resources/auth"))).toBe(true);
  });

  it("should NOT create Better Auth config file", async () => {
    expect(await exists(path.join(projectPath, "src/auth.ts"))).toBe(false);
  });

  it("should create package.json with correct structure", async () => {
    const pkg = await readJson(path.join(projectPath, "package.json"));
    expect(pkg.name).toBe(projectName);
    expect(pkg.type).toBe("module");
    expect(pkg.scripts).toHaveProperty("dev");
    expect(pkg.scripts).toHaveProperty("test");
    expect(pkg.scripts.test).toContain("vitest");
    expect(pkg.imports).toHaveProperty("#config/*");
    expect(pkg.imports).toHaveProperty("#shared/*");
    expect(pkg.imports).toHaveProperty("#resources/*");
  });

  it("scaffolded package.json advertises the same Node engine as @classytic/arc itself", async () => {
    // Regression guard — pre-fix the scaffold claimed `>=20` while arc
    // itself requires `>=22`, so a freshly-generated app could advertise
    // support for a runtime that the framework does not support. Lock both
    // sides to the same requirement so either version bump keeps them in
    // sync (or the test fails at the bump point and forces a decision).
    const scaffoldPkg = await readJson(path.join(projectPath, "package.json"));
    const rootPkg = await readJson(path.join(__dirname, "..", "..", "package.json"));
    expect(scaffoldPkg.engines?.node).toBeDefined();
    expect(rootPkg.engines?.node).toBeDefined();
    expect(scaffoldPkg.engines.node).toBe(rootPkg.engines.node);
  });

  it("should create tsconfig.json for TypeScript", async () => {
    const tsconfig = await readJson(path.join(projectPath, "tsconfig.json"));
    expect(tsconfig.compilerOptions.target).toBe("ES2022");
    expect(tsconfig.compilerOptions.module).toBe("NodeNext");
    expect(tsconfig.compilerOptions.moduleResolution).toBe("NodeNext");
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it("should create vitest config", async () => {
    const content = await readText(path.join(projectPath, "vitest.config.ts"));
    expect(content).toContain("defineConfig");
    expect(content).toContain("globals: true");
  });

  it("should create .arcrc with project config", async () => {
    const arcrc = await readJson(path.join(projectPath, ".arcrc"));
    expect(arcrc.adapter).toBe("mongokit");
    expect(arcrc.auth).toBe("jwt");
    expect(arcrc.tenant).toBe("single");
    expect(arcrc.typescript).toBe(true);
  });

  it("should create env files", async () => {
    expect(await exists(path.join(projectPath, ".env.example"))).toBe(true);
    expect(await exists(path.join(projectPath, ".env.dev"))).toBe(true);
    const envExample = await readText(path.join(projectPath, ".env.example"));
    expect(envExample).toContain("JWT_SECRET");
    expect(envExample).not.toContain("BETTER_AUTH_SECRET");
  });

  it("should create .gitignore", async () => {
    const content = await readText(path.join(projectPath, ".gitignore"));
    expect(content).toContain("node_modules");
    expect(content).toContain("dist/");
    expect(content).toContain(".env");
  });

  it("should create example resource files", async () => {
    const exampleDir = path.join(projectPath, "src/resources/example");
    expect(await exists(path.join(exampleDir, "example.model.ts"))).toBe(true);
    expect(await exists(path.join(exampleDir, "example.repository.ts"))).toBe(true);
    expect(await exists(path.join(exampleDir, "example.resource.ts"))).toBe(true);
    expect(await exists(path.join(exampleDir, "example.controller.ts"))).toBe(true);
    expect(await exists(path.join(exampleDir, "example.schemas.ts"))).toBe(true);
  });

  it("should create JWT auth resource files", async () => {
    const userDir = path.join(projectPath, "src/resources/user");
    const authDir = path.join(projectPath, "src/resources/auth");
    expect(await exists(path.join(userDir, "user.model.ts"))).toBe(true);
    expect(await exists(path.join(userDir, "user.repository.ts"))).toBe(true);
    expect(await exists(path.join(userDir, "user.controller.ts"))).toBe(true);
    expect(await exists(path.join(authDir, "auth.resource.ts"))).toBe(true);
    expect(await exists(path.join(authDir, "auth.handlers.ts"))).toBe(true);
    expect(await exists(path.join(authDir, "auth.schemas.ts"))).toBe(true);
  });

  it("should create app entry files", async () => {
    expect(await exists(path.join(projectPath, "src/app.ts"))).toBe(true);
    expect(await exists(path.join(projectPath, "src/index.ts"))).toBe(true);
  });

  it("should create config files", async () => {
    expect(await exists(path.join(projectPath, "src/config/env.ts"))).toBe(true);
    expect(await exists(path.join(projectPath, "src/config/index.ts"))).toBe(true);
  });

  it("should create shared files", async () => {
    expect(await exists(path.join(projectPath, "src/shared/adapter.ts"))).toBe(true);
    expect(await exists(path.join(projectPath, "src/shared/permissions.ts"))).toBe(true);
    expect(await exists(path.join(projectPath, "src/shared/index.ts"))).toBe(true);
  });

  it("should create test files", async () => {
    expect(await exists(path.join(projectPath, "tests/example.test.ts"))).toBe(true);
    expect(await exists(path.join(projectPath, "tests/auth.test.ts"))).toBe(true);
  });

  // Content validation
  it("should generate valid app.ts with JWT auth imports", async () => {
    const content = await readText(path.join(projectPath, "src/app.ts"));
    expect(content).toContain("createApp");
    expect(content).toContain("jwt");
  });

  it("should generate adapter with MongoKit imports", async () => {
    const content = await readText(path.join(projectPath, "src/shared/adapter.ts"));
    expect(content).toContain("mongokit");
  });

  it("should generate example resource with defineResource", async () => {
    const content = await readText(
      path.join(projectPath, "src/resources/example/example.resource.ts"),
    );
    expect(content).toContain("defineResource");
    // Uses shared adapter factory (createAdapter from #shared/adapter.js)
    expect(content).toContain("createAdapter");
  });
});

// ============================================================================
// Better Auth + Single Tenant
// ============================================================================

describe("arc init — Better Auth + Single Tenant", () => {
  const projectName = "test-ba-single";
  let projectPath: string;

  beforeAll(async () => {
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      await init({
        name: projectName,
        adapter: "mongokit",
        auth: "better-auth",
        tenant: "single",
        typescript: true,
        skipInstall: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
    projectPath = path.join(testRoot, projectName);
  });

  it("should create Better Auth config file", async () => {
    expect(await exists(path.join(projectPath, "src/auth.ts"))).toBe(true);
    const content = await readText(path.join(projectPath, "src/auth.ts"));
    expect(content).toContain("betterAuth");
  });

  it("should NOT create JWT auth resource directories", async () => {
    expect(await exists(path.join(projectPath, "src/resources/user"))).toBe(false);
    expect(await exists(path.join(projectPath, "src/resources/auth"))).toBe(false);
  });

  it("should NOT create auth test file (JWT-only)", async () => {
    expect(await exists(path.join(projectPath, "tests/auth.test.ts"))).toBe(false);
  });

  it("should have BETTER_AUTH_SECRET in env example", async () => {
    const content = await readText(path.join(projectPath, ".env.example"));
    expect(content).toContain("BETTER_AUTH_SECRET");
    expect(content).not.toContain("JWT_SECRET");
  });

  it("should save correct .arcrc", async () => {
    const arcrc = await readJson(path.join(projectPath, ".arcrc"));
    expect(arcrc.auth).toBe("better-auth");
    expect(arcrc.tenant).toBe("single");
  });

  it("should generate app.ts with Better Auth setup", async () => {
    const content = await readText(path.join(projectPath, "src/app.ts"));
    expect(content).toContain("betterAuth");
  });
});

// ============================================================================
// JWT + Multi Tenant
// ============================================================================

describe("arc init — JWT + Multi Tenant", () => {
  const projectName = "test-jwt-multi";
  let projectPath: string;

  beforeAll(async () => {
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      await init({
        name: projectName,
        adapter: "mongokit",
        auth: "jwt",
        tenant: "multi",
        typescript: true,
        skipInstall: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
    projectPath = path.join(testRoot, projectName);
  });

  it("should create multi-tenant preset files", async () => {
    const presetsDir = path.join(projectPath, "src/shared/presets");
    expect(await exists(path.join(presetsDir, "index.ts"))).toBe(true);
    // Multi-tenant should have flexible preset
    expect(await exists(path.join(presetsDir, "flexible-multi-tenant.ts"))).toBe(true);
  });

  it("should save multi-tenant in .arcrc", async () => {
    const arcrc = await readJson(path.join(projectPath, ".arcrc"));
    expect(arcrc.tenant).toBe("multi");
  });

  it("should include ORG_HEADER in env example", async () => {
    const content = await readText(path.join(projectPath, ".env.example"));
    expect(content).toContain("ORG_HEADER");
  });
});

// ============================================================================
// Better Auth + Multi Tenant
// ============================================================================

describe("arc init — Better Auth + Multi Tenant", () => {
  const projectName = "test-ba-multi";
  let projectPath: string;

  beforeAll(async () => {
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      await init({
        name: projectName,
        adapter: "mongokit",
        auth: "better-auth",
        tenant: "multi",
        typescript: true,
        skipInstall: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
    projectPath = path.join(testRoot, projectName);
  });

  it("should create both Better Auth and multi-tenant files", async () => {
    expect(await exists(path.join(projectPath, "src/auth.ts"))).toBe(true);
    expect(
      await exists(path.join(projectPath, "src/shared/presets/flexible-multi-tenant.ts")),
    ).toBe(true);
  });

  it("should have both BETTER_AUTH_SECRET and ORG_HEADER in env", async () => {
    const content = await readText(path.join(projectPath, ".env.example"));
    expect(content).toContain("BETTER_AUTH_SECRET");
    expect(content).toContain("ORG_HEADER");
  });

  it("should save correct .arcrc", async () => {
    const arcrc = await readJson(path.join(projectPath, ".arcrc"));
    expect(arcrc.auth).toBe("better-auth");
    expect(arcrc.tenant).toBe("multi");
  });
});

// ============================================================================
// Custom Adapter (no MongoKit)
// ============================================================================

describe("arc init — Custom Adapter", () => {
  const projectName = "test-custom-adapter";
  let projectPath: string;

  beforeAll(async () => {
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      await init({
        name: projectName,
        adapter: "custom",
        auth: "jwt",
        tenant: "single",
        typescript: true,
        skipInstall: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
    projectPath = path.join(testRoot, projectName);
  });

  it("should create custom adapter template", async () => {
    const content = await readText(path.join(projectPath, "src/shared/adapter.ts"));
    // Custom adapter should NOT pull in any kit-specific package — that's
    // the whole point of "custom". Hosts that want a kit-supplied factory
    // pick a different `arc init` adapter option.
    expect(content).not.toContain("@classytic/mongokit");
    expect(content).not.toContain("@classytic/sqlitekit");
    expect(content).not.toContain("@classytic/prismakit");
    expect(content).not.toContain("createMongooseAdapter");
    expect(content).not.toContain("createDrizzleAdapter");
    expect(content).not.toContain("createPrismaAdapter");
    expect(content).toContain("RepositoryLike");
    expect(content).toContain("@classytic/repo-core/adapter");
  });

  it("should save custom adapter in .arcrc", async () => {
    const arcrc = await readJson(path.join(projectPath, ".arcrc"));
    expect(arcrc.adapter).toBe("custom");
  });
});

// ============================================================================
// JavaScript Mode
// ============================================================================

describe("arc init — JavaScript mode", () => {
  const projectName = "test-js-mode";
  let projectPath: string;

  beforeAll(async () => {
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      await init({
        name: projectName,
        adapter: "mongokit",
        auth: "jwt",
        tenant: "single",
        typescript: false,
        skipInstall: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
    projectPath = path.join(testRoot, projectName);
  });

  it("should create .js files instead of .ts", async () => {
    expect(await exists(path.join(projectPath, "src/app.js"))).toBe(true);
    expect(await exists(path.join(projectPath, "src/index.js"))).toBe(true);
    expect(await exists(path.join(projectPath, "src/config/env.js"))).toBe(true);
  });

  it("should NOT create tsconfig.json", async () => {
    expect(await exists(path.join(projectPath, "tsconfig.json"))).toBe(false);
  });

  it("should save typescript: false in .arcrc", async () => {
    const arcrc = await readJson(path.join(projectPath, ".arcrc"));
    expect(arcrc.typescript).toBe(false);
  });
});

// ============================================================================
// Error Handling
// ============================================================================

describe("arc init — Error handling", () => {
  it("should throw when directory exists without --force", async () => {
    const originalCwd = process.cwd();
    const existingDir = path.join(testRoot, "existing-project");
    await fs.mkdir(existingDir, { recursive: true });
    process.chdir(testRoot);
    try {
      await expect(init({ name: "existing-project", skipInstall: true })).rejects.toThrow(
        "already exists",
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("should allow overwrite with --force", async () => {
    const originalCwd = process.cwd();
    process.chdir(testRoot);
    try {
      // This should NOT throw
      await init({
        name: "existing-project",
        adapter: "mongokit",
        auth: "jwt",
        tenant: "single",
        typescript: true,
        skipInstall: true,
        force: true,
      });
      expect(await exists(path.join(testRoot, "existing-project", "package.json"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
