/**
 * Arc CLI - Generated App Verification Tests
 *
 * Scaffolds full projects via `arc init`, then verifies the generated code:
 * - CRUD resource patterns are valid (defineResource, adapter, permissions)
 * - Auth setup is correct (JWT handlers or Better Auth config)
 * - Events/hooks patterns are present
 * - Config/env loading follows Arc conventions
 * - Templates produce syntactically valid code
 *
 * These tests do NOT install dependencies or run the generated app.
 * They verify the code structure, patterns, and correctness statically.
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init } from "../../src/cli/commands/init.js";

let testRoot: string;

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

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

async function scaffoldProject(name: string, options: Parameters<typeof init>[0]): Promise<string> {
  const originalCwd = process.cwd();
  process.chdir(testRoot);
  try {
    await init({ name, skipInstall: true, ...options });
  } finally {
    process.chdir(originalCwd);
  }
  return path.join(testRoot, name);
}

beforeAll(async () => {
  testRoot = path.join(
    tmpdir(),
    `arc-cli-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
// CRUD Resource Verification — JWT + Single Tenant
// ============================================================================

describe("Generated App — CRUD Resource Patterns (JWT + Single)", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-crud-jwt", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: true,
    });
  });

  it("should generate example resource with defineResource pattern", async () => {
    const content = await readText(
      path.join(projectPath, "src/resources/example/example.resource.ts"),
    );
    // Must use defineResource from arc
    expect(content).toContain("import");
    expect(content).toContain("defineResource");
    expect(content).toContain("@classytic/arc");
    // Must use shared adapter factory
    expect(content).toContain("createAdapter");
    // Must define permissions (via shared permissions import)
    expect(content).toMatch(/permissions/);
    // Must export the resource
    expect(content).toMatch(/export\s+default/);
  });

  it("should generate example model with Mongoose schema", async () => {
    const content = await readText(
      path.join(projectPath, "src/resources/example/example.model.ts"),
    );
    expect(content).toContain("mongoose");
    expect(content).toContain("Schema");
    expect(content).toContain("timestamps: true");
    // Uses InferSchemaType instead of interface
    expect(content).toContain("ExampleDocument");
    expect(content).toContain("mongoose.model");
  });

  it("should generate example repository with MongoKit", async () => {
    const content = await readText(
      path.join(projectPath, "src/resources/example/example.repository.ts"),
    );
    expect(content).toContain("@classytic/mongokit");
    expect(content).toContain("Repository");
    expect(content).toContain("ExampleRepository");
    // Should export instance and class
    expect(content).toContain("exampleRepository");
  });

  it("should generate example controller extending BaseController", async () => {
    const content = await readText(
      path.join(projectPath, "src/resources/example/example.controller.ts"),
    );
    expect(content).toContain("BaseController");
    expect(content).toContain("ExampleController");
    // Uses schemaOptions instead of resourceName
    expect(content).toContain("schemaOptions");
  });

  it("should generate example schemas with buildCrudSchemasFromModel", async () => {
    const content = await readText(
      path.join(projectPath, "src/resources/example/example.schemas.ts"),
    );
    expect(content).toContain("buildCrudSchemasFromModel");
    expect(content).toContain("fieldRules");
    expect(content).toContain("filterableFields");
  });

  it("should generate resources index that exports resources array", async () => {
    const content = await readText(path.join(projectPath, "src/resources/index.ts"));
    expect(content).toContain("exampleResource");
    // Should be an array export for factory consumption
    expect(content).toMatch(/resources/);
  });
});

// ============================================================================
// Auth Setup Verification — JWT Mode
// ============================================================================

describe("Generated App — JWT Auth Setup", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-auth-jwt", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: true,
    });
  });

  it("should generate user model with password hashing", async () => {
    const content = await readText(path.join(projectPath, "src/resources/user/user.model.ts"));
    expect(content).toContain("mongoose");
    expect(content).toContain("password");
    expect(content).toContain("email");
  });

  it("should generate user repository", async () => {
    const content = await readText(path.join(projectPath, "src/resources/user/user.repository.ts"));
    expect(content).toContain("Repository");
    expect(content).toContain("UserRepository");
  });

  it("should generate auth handlers with login/register", async () => {
    const content = await readText(path.join(projectPath, "src/resources/auth/auth.handlers.ts"));
    // Should handle registration and login flows
    expect(content).toMatch(/register|signup|sign.*up/i);
    expect(content).toMatch(/login|signin|sign.*in/i);
  });

  it("should generate auth resource definition", async () => {
    const content = await readText(path.join(projectPath, "src/resources/auth/auth.resource.ts"));
    expect(content).toContain("@classytic/arc");
  });

  it("should generate auth schemas for login/register", async () => {
    const content = await readText(path.join(projectPath, "src/resources/auth/auth.schemas.ts"));
    expect(content).toContain("email");
    expect(content).toContain("password");
  });

  it("should generate auth test file", async () => {
    const content = await readText(path.join(projectPath, "tests/auth.test.ts"));
    expect(content).toContain("describe");
    expect(content).toContain("vitest");
  });

  it("should configure JWT in app.ts", async () => {
    const content = await readText(path.join(projectPath, "src/app.ts"));
    expect(content).toContain("jwt");
    expect(content).toContain("createApp");
  });
});

// ============================================================================
// Auth Setup Verification — Better Auth Mode
// ============================================================================

describe("Generated App — Better Auth Setup", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-auth-ba", {
      adapter: "mongokit",
      auth: "better-auth",
      tenant: "single",
      typescript: true,
    });
  });

  it("should generate auth.ts with Better Auth config", async () => {
    const content = await readText(path.join(projectPath, "src/auth.ts"));
    expect(content).toContain("betterAuth");
    expect(content).toContain("database");
  });

  it("should NOT generate manual JWT auth files", async () => {
    expect(await exists(path.join(projectPath, "src/resources/user/user.model.ts"))).toBe(false);
    expect(await exists(path.join(projectPath, "src/resources/auth/auth.handlers.ts"))).toBe(false);
  });

  it("should configure Better Auth in app.ts", async () => {
    const content = await readText(path.join(projectPath, "src/app.ts"));
    // Uses betterAuth type and createBetterAuthAdapter
    expect(content).toContain("betterAuth");
    expect(content).toContain("createBetterAuthAdapter");
  });

  it("should reference BETTER_AUTH_SECRET in config", async () => {
    const configContent = await readText(path.join(projectPath, "src/config/index.ts"));
    const envContent = await readText(path.join(projectPath, ".env.example"));
    // At least one of these should reference the secret
    const combined = configContent + envContent;
    expect(combined).toContain("BETTER_AUTH_SECRET");
  });
});

// ============================================================================
// Config & Entry Point Verification
// ============================================================================

describe("Generated App — Config & Entry Points", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-config", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: true,
    });
  });

  it("should load env before other imports in index.ts", async () => {
    const content = await readText(path.join(projectPath, "src/index.ts"));
    // Find actual import statements (not comments)
    const lines = content.split("\n");
    const envImportLine = lines.findIndex(
      (l) => l.startsWith("import") && l.includes("config/env"),
    );
    const appImportLine = lines.findIndex(
      (l) => l.startsWith("import") && l.includes("createAppInstance"),
    );
    expect(envImportLine).toBeGreaterThan(-1);
    expect(appImportLine).toBeGreaterThan(-1);
    // Env import should come before app import
    expect(envImportLine).toBeLessThan(appImportLine);
  });

  it("should export createAppInstance from app.ts", async () => {
    const content = await readText(path.join(projectPath, "src/app.ts"));
    expect(content).toContain("createAppInstance");
    expect(content).toContain("export");
  });

  it("should generate config with env-based settings", async () => {
    const content = await readText(path.join(projectPath, "src/config/index.ts"));
    expect(content).toContain("process.env");
    expect(content).toContain("PORT");
  });

  it("should generate env loader with NODE_ENV detection", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain("NODE_ENV");
  });

  it("should create app factory using Arc createApp", async () => {
    const content = await readText(path.join(projectPath, "src/app.ts"));
    expect(content).toContain("@classytic/arc/factory");
    expect(content).toContain("createApp");
  });

  it("should connect to MongoDB in entry point", async () => {
    const content = await readText(path.join(projectPath, "src/index.ts"));
    expect(content).toContain("mongoose");
    expect(content).toContain("connect");
  });
});

// ============================================================================
// Multi-Tenant Verification
// ============================================================================

describe("Generated App — Multi-Tenant Patterns", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-multi-tenant", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "multi",
      typescript: true,
    });
  });

  it("should generate flexible multi-tenant preset", async () => {
    const content = await readText(
      path.join(projectPath, "src/shared/presets/flexible-multi-tenant.ts"),
    );
    // Should define a multi-tenant preset function
    expect(content).toMatch(/tenant|organization|org/i);
  });

  it("should export presets from presets index", async () => {
    const content = await readText(path.join(projectPath, "src/shared/presets/index.ts"));
    expect(content).toContain("export");
  });

  it("should reference org header in config", async () => {
    const envContent = await readText(path.join(projectPath, ".env.example"));
    expect(envContent).toContain("ORG_HEADER");
  });
});

// ============================================================================
// Shared Utilities Verification
// ============================================================================

describe("Generated App — Shared Utilities", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-shared", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: true,
    });
  });

  it("should generate adapter module with MongoKit factory", async () => {
    const content = await readText(path.join(projectPath, "src/shared/adapter.ts"));
    expect(content).toContain("createMongooseAdapter");
  });

  it("should generate permissions module", async () => {
    const content = await readText(path.join(projectPath, "src/shared/permissions.ts"));
    // Should import from arc permissions
    expect(content).toContain("@classytic/arc");
    expect(content).toMatch(/permission|role|auth/i);
  });

  it("should generate shared index barrel", async () => {
    const content = await readText(path.join(projectPath, "src/shared/index.ts"));
    expect(content).toContain("export");
  });

  it("should generate plugins index", async () => {
    const content = await readText(path.join(projectPath, "src/plugins/index.ts"));
    expect(content).toContain("export");
  });
});

// ============================================================================
// Test File Verification
// ============================================================================

describe("Generated App — Test Files", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-tests", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: true,
    });
  });

  it("should generate example test with Vitest imports", async () => {
    const content = await readText(path.join(projectPath, "tests/example.test.ts"));
    expect(content).toContain("vitest");
    expect(content).toContain("describe");
    expect(content).toContain("expect");
  });

  it("should generate example test with CRUD test pattern (2.11 surface)", async () => {
    const content = await readText(path.join(projectPath, "tests/example.test.ts"));
    // Tests the list endpoint via the 2.11 testing surface.
    expect(content).toContain("GET");
    // expectArc matchers replace raw statusCode assertions.
    expect(content).toContain("expectArc");
  });

  it("should generate example test with app lifecycle (createTestApp)", async () => {
    const content = await readText(path.join(projectPath, "tests/example.test.ts"));
    // Setup/teardown present.
    expect(content).toMatch(/beforeAll|beforeEach/);
    expect(content).toMatch(/afterAll|afterEach/);
    // 2.11 testing surface — createTestApp from @classytic/arc/testing
    // replaces the pre-2.11 createAppInstance import in test files.
    expect(content).toContain("createTestApp");
  });

  it("should generate auth test when using JWT", async () => {
    const content = await readText(path.join(projectPath, "tests/auth.test.ts"));
    expect(content).toContain("vitest");
    expect(content).toContain("describe");
  });

  it("should generate vitest config with proper setup", async () => {
    const content = await readText(path.join(projectPath, "vitest.config.ts"));
    expect(content).toContain("defineConfig");
    expect(content).toContain("globals: true");
    expect(content).toContain("environment: 'node'");
    // Should have path aliases for subpath imports
    expect(content).toContain("#config");
    expect(content).toContain("#shared");
  });
});

// ============================================================================
// Package.json Verification
// ============================================================================

describe("Generated App — Package.json Patterns", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-pkg", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: true,
    });
  });

  it("should be ESM (type: module)", async () => {
    const pkg = await readJson(path.join(projectPath, "package.json"));
    expect(pkg.type).toBe("module");
  });

  it("should have dev, build, start, and test scripts", async () => {
    const pkg = await readJson(path.join(projectPath, "package.json"));
    expect(pkg.scripts.dev).toBeDefined();
    expect(pkg.scripts.build).toBeDefined();
    expect(pkg.scripts.start).toBeDefined();
    expect(pkg.scripts.test).toBeDefined();
  });

  it("should use tsx for dev (TypeScript)", async () => {
    const pkg = await readJson(path.join(projectPath, "package.json"));
    expect(pkg.scripts.dev).toContain("tsx");
  });

  it("should use vitest for testing", async () => {
    const pkg = await readJson(path.join(projectPath, "package.json"));
    expect(pkg.scripts.test).toContain("vitest");
  });

  it("should have subpath imports for clean architecture", async () => {
    const pkg = await readJson(path.join(projectPath, "package.json"));
    expect(pkg.imports["#config/*"]).toBe("./src/config/*");
    expect(pkg.imports["#shared/*"]).toBe("./src/shared/*");
    expect(pkg.imports["#resources/*"]).toBe("./src/resources/*");
    expect(pkg.imports["#plugins/*"]).toBe("./src/plugins/*");
  });

  it("should require the same Node engine as @classytic/arc itself", async () => {
    // Pre-fix this asserted `">=20"` while arc's own `engines.node` was
    // `">=22"` — scaffolded apps advertised support for a runtime the
    // framework doesn't support. Pin to arc's root requirement so either
    // version bump keeps the two in sync or the test fails at the bump.
    const pkg = await readJson(path.join(projectPath, "package.json"));
    const rootPkg = await readJson(path.join(__dirname, "..", "..", "package.json"));
    expect(pkg.engines.node).toBe(rootPkg.engines.node);
  });
});

// ============================================================================
// JavaScript Mode Verification
// ============================================================================

describe("Generated App — JavaScript Mode", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await scaffoldProject("verify-js", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: false,
    });
  });

  it("should generate .js files (not .ts)", async () => {
    expect(await exists(path.join(projectPath, "src/app.js"))).toBe(true);
    expect(await exists(path.join(projectPath, "src/app.ts"))).toBe(false);
  });

  it("should generate example resource without TypeScript types", async () => {
    const content = await readText(
      path.join(projectPath, "src/resources/example/example.model.js"),
    );
    expect(content).not.toContain("interface");
    expect(content).not.toContain(": string");
    expect(content).toContain("mongoose");
  });

  it("should use --watch for JS dev instead of tsx", async () => {
    const pkg = await readJson(path.join(projectPath, "package.json"));
    expect(pkg.scripts.dev).toContain("--watch");
    expect(pkg.scripts.dev).not.toContain("tsx");
  });
});
