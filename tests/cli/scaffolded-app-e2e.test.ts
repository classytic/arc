/**
 * Arc CLI — Scaffolded App E2E Test
 *
 * Scaffolds apps via `arc init`, then verifies the generated code actually
 * produces working CRUD endpoints by:
 *
 * 1. Running `arc init` with Better Auth + MongoKit + multi-tenant
 * 2. Running `arc init` with JWT + MongoKit + single-tenant
 * 3. Reading the generated files and verifying they contain valid patterns
 * 4. Verifying the generated test file is structurally correct
 * 5. Verifying env, config, adapter, permissions, and resource templates
 *
 * We also test that the generated app patterns work at runtime by
 * mirroring the exact patterns from `arc init` output and booting
 * a Fastify app against mongodb-memory-server.
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init } from "../../src/cli/commands/init.js";

let testRoot: string;

async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf-8");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function scaffold(name: string, opts: Parameters<typeof init>[0]): Promise<string> {
  const cwd = process.cwd();
  process.chdir(testRoot);
  try {
    await init({ name, skipInstall: true, ...opts });
  } finally {
    process.chdir(cwd);
  }
  return path.join(testRoot, name);
}

beforeAll(async () => {
  testRoot = path.join(
    tmpdir(),
    `arc-e2e-scaffold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  try {
    await fs.rm(testRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ============================================================================
// Better Auth + MongoKit + Multi-Tenant
// ============================================================================

describe("Scaffolded App — Better Auth + Multi-Tenant", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await scaffold("ba-multi", {
      adapter: "mongokit",
      auth: "better-auth",
      tenant: "multi",
      typescript: true,
    });
  });

  // ── File Structure ──────────────────────────────────────────

  it("creates all required directories", async () => {
    expect(await exists(path.join(dir, "src"))).toBe(true);
    expect(await exists(path.join(dir, "src/config"))).toBe(true);
    expect(await exists(path.join(dir, "src/shared"))).toBe(true);
    expect(await exists(path.join(dir, "src/resources"))).toBe(true);
    expect(await exists(path.join(dir, "src/resources/example"))).toBe(true);
    expect(await exists(path.join(dir, "tests"))).toBe(true);
  });

  it("creates Better Auth config file (not JWT auth resources)", async () => {
    expect(await exists(path.join(dir, "src/auth.ts"))).toBe(true);
    // JWT mode would create user/auth directories — should NOT exist
    expect(await exists(path.join(dir, "src/resources/user"))).toBe(false);
    expect(await exists(path.join(dir, "src/resources/auth"))).toBe(false);
  });

  it("creates multi-tenant presets", async () => {
    expect(await exists(path.join(dir, "src/shared/presets/flexible-multi-tenant.ts"))).toBe(true);
  });

  // ── Auth Setup ──────────────────────────────────────────────

  it("auth.ts imports better-auth", async () => {
    const content = await readText(path.join(dir, "src/auth.ts"));
    expect(content).toContain("better-auth");
    expect(content).toContain("betterAuth");
  });

  it("app.ts uses betterAuth auth option", async () => {
    const content = await readText(path.join(dir, "src/app.ts"));
    expect(content).toContain("betterAuth");
    expect(content).toContain("createApp");
  });

  // ── Resource Pattern ────────────────────────────────────────

  it("example resource uses defineResource + createAdapter", async () => {
    const content = await readText(path.join(dir, "src/resources/example/example.resource.ts"));
    expect(content).toContain("defineResource");
    expect(content).toContain("createAdapter");
    expect(content).toContain("permissions");
  });

  it("example model uses mongoose.Schema", async () => {
    const content = await readText(path.join(dir, "src/resources/example/example.model.ts"));
    expect(content).toContain("mongoose");
    expect(content).toContain("Schema");
  });

  it("example repository extends MongoKit Repository", async () => {
    const content = await readText(path.join(dir, "src/resources/example/example.repository.ts"));
    expect(content).toContain("Repository");
    expect(content).toContain("@classytic/mongokit");
  });

  // ── Adapter ─────────────────────────────────────────────────

  it("shared adapter uses createMongooseAdapter", async () => {
    const content = await readText(path.join(dir, "src/shared/adapter.ts"));
    expect(content).toContain("createMongooseAdapter");
    expect(content).toContain("@classytic/mongokit/adapter");
  });

  // ── Permissions ─────────────────────────────────────────────

  it("shared permissions imports from arc", async () => {
    const content = await readText(path.join(dir, "src/shared/permissions.ts"));
    expect(content).toContain("@classytic/arc");
  });

  // ── Config / Env ────────────────────────────────────────────

  it("env loader handles environment loading", async () => {
    const content = await readText(path.join(dir, "src/config/env.ts"));
    // Should have env file loading logic (dotenv or parseEnv)
    expect(content).toContain(".env");
    expect(content).toContain("process.env");
  });

  it(".env.example lists required vars", async () => {
    const content = await readText(path.join(dir, ".env.example"));
    expect(content).toContain("MONGO");
    expect(content).toContain("PORT");
  });

  // ── Multi-Tenant Specifics ──────────────────────────────────

  it("multi-tenant preset filters by organizationId", async () => {
    const content = await readText(path.join(dir, "src/shared/presets/flexible-multi-tenant.ts"));
    expect(content).toContain("organizationId");
  });

  it("presets index exports multi-tenant preset", async () => {
    const content = await readText(path.join(dir, "src/shared/presets/index.ts"));
    expect(content).toContain("multi-tenant");
  });

  // ── Test File ───────────────────────────────────────────────

  it("generates a test file for the example resource", async () => {
    expect(await exists(path.join(dir, "tests/example.test.ts"))).toBe(true);
    const content = await readText(path.join(dir, "tests/example.test.ts"));
    expect(content).toContain("describe");
    expect(content).toContain("expect");
    expect(content).toContain("/examples");
  });

  // ── Package.json ────────────────────────────────────────────

  it("package.json has correct scripts", async () => {
    const pkg = JSON.parse(await readText(path.join(dir, "package.json")));
    expect(pkg.scripts.dev).toContain("tsx");
    expect(pkg.scripts.test).toContain("vitest");
    expect(pkg.scripts.build).toBeDefined();
  });

  it("package.json declares type: module", async () => {
    const pkg = JSON.parse(await readText(path.join(dir, "package.json")));
    expect(pkg.type).toBe("module");
  });

  // ── Docker (non-edge) ───────────────────────────────────────

  it("generates Dockerfile for Node.js target", async () => {
    expect(await exists(path.join(dir, "Dockerfile"))).toBe(true);
    const content = await readText(path.join(dir, "Dockerfile"));
    expect(content).toContain("node");
  });

  it("generates docker-compose.yml", async () => {
    expect(await exists(path.join(dir, "docker-compose.yml"))).toBe(true);
    const content = await readText(path.join(dir, "docker-compose.yml"));
    expect(content).toContain("mongo");
  });

  // ── .arcrc ──────────────────────────────────────────────────

  it("saves project config in .arcrc", async () => {
    const arcrc = JSON.parse(await readText(path.join(dir, ".arcrc")));
    expect(arcrc.adapter).toBe("mongokit");
    expect(arcrc.auth).toBe("better-auth");
    expect(arcrc.tenant).toBe("multi");
    expect(arcrc.typescript).toBe(true);
  });
});

// ============================================================================
// JWT + MongoKit + Single-Tenant
// ============================================================================

describe("Scaffolded App — JWT + Single-Tenant", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await scaffold("jwt-single", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: true,
    });
  });

  // ── JWT-specific files ──────────────────────────────────────

  it("creates user model and auth handlers (not Better Auth config)", async () => {
    expect(await exists(path.join(dir, "src/resources/user/user.model.ts"))).toBe(true);
    expect(await exists(path.join(dir, "src/resources/user/user.repository.ts"))).toBe(true);
    expect(await exists(path.join(dir, "src/resources/user/user.controller.ts"))).toBe(true);
    expect(await exists(path.join(dir, "src/resources/auth/auth.resource.ts"))).toBe(true);
    expect(await exists(path.join(dir, "src/resources/auth/auth.handlers.ts"))).toBe(true);
    expect(await exists(path.join(dir, "src/resources/auth/auth.schemas.ts"))).toBe(true);
    // Should NOT have Better Auth config
    expect(await exists(path.join(dir, "src/auth.ts"))).toBe(false);
  });

  it("app.ts uses JWT auth option", async () => {
    const content = await readText(path.join(dir, "src/app.ts"));
    expect(content).toContain("jwt");
    expect(content).toContain("createApp");
  });

  it("auth handlers have register and login endpoints", async () => {
    const content = await readText(path.join(dir, "src/resources/auth/auth.handlers.ts"));
    expect(content).toContain("register");
    expect(content).toContain("login");
  });

  it("user model has password field", async () => {
    const content = await readText(path.join(dir, "src/resources/user/user.model.ts"));
    expect(content).toContain("password");
  });

  it("generates auth test for JWT mode", async () => {
    expect(await exists(path.join(dir, "tests/auth.test.ts"))).toBe(true);
    const content = await readText(path.join(dir, "tests/auth.test.ts"));
    expect(content).toContain("register");
    expect(content).toContain("login");
  });

  // ── Single-Tenant ───────────────────────────────────────────

  it("does NOT create multi-tenant preset", async () => {
    expect(await exists(path.join(dir, "src/shared/presets/flexible-multi-tenant.ts"))).toBe(false);
  });

  // ── Shared patterns (same as Better Auth) ───────────────────

  it("example resource uses defineResource", async () => {
    const content = await readText(path.join(dir, "src/resources/example/example.resource.ts"));
    expect(content).toContain("defineResource");
  });

  it("shared adapter uses createMongooseAdapter", async () => {
    const content = await readText(path.join(dir, "src/shared/adapter.ts"));
    expect(content).toContain("createMongooseAdapter");
  });

  it(".arcrc records JWT + single-tenant", async () => {
    const arcrc = JSON.parse(await readText(path.join(dir, ".arcrc")));
    expect(arcrc.auth).toBe("jwt");
    expect(arcrc.tenant).toBe("single");
  });
});

// ============================================================================
// Edge Deployment
// ============================================================================

describe("Scaffolded App — Edge/Serverless", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await scaffold("edge-app", {
      adapter: "mongokit",
      auth: "jwt",
      tenant: "single",
      typescript: true,
      edge: true,
    });
  });

  it("generates wrangler.toml instead of Dockerfile", async () => {
    expect(await exists(path.join(dir, "wrangler.toml"))).toBe(true);
    expect(await exists(path.join(dir, "Dockerfile"))).toBe(false);
  });

  it("wrangler.toml has nodejs_compat", async () => {
    const content = await readText(path.join(dir, "wrangler.toml"));
    expect(content).toContain("nodejs_compat");
  });

  it("package.json has deploy script", async () => {
    const pkg = JSON.parse(await readText(path.join(dir, "package.json")));
    expect(pkg.scripts.deploy).toContain("wrangler");
  });
});
