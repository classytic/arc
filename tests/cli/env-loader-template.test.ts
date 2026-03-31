/**
 * Env Loader Template Tests
 *
 * Verifies the arc init generated env.ts follows Next.js-style priority:
 *   .env.local → .env.{long} → .env.{short} → .env
 * And the config/index.ts properly reads environment variables.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { init } from "../../src/cli/commands/init.js";

let testRoot: string;
let projectPath: string;

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

beforeAll(async () => {
  testRoot = path.join(
    tmpdir(),
    `arc-env-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(testRoot, { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(testRoot);
  try {
    await init({
      name: "env-test",
      adapter: "mongokit",
      auth: "better-auth",
      tenant: "single",
      typescript: true,
      skipInstall: true,
    });
  } finally {
    process.chdir(originalCwd);
  }
  projectPath = path.join(testRoot, "env-test");
});

afterAll(async () => {
  try {
    await fs.rm(testRoot, { recursive: true, force: true });
  } catch {
    // Ignore
  }
});

// ============================================================================
// env.ts template
// ============================================================================

describe("env.ts template", () => {
  it("should import dotenv", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain("import dotenv from 'dotenv'");
  });

  it("should support .env.local as highest priority", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain(".env.local");
    // In the candidates array, .env.local should be first
    const candidatesMatch = content.match(/const candidates[\s\S]*?\];/);
    expect(candidatesMatch).toBeDefined();
    const candidates = candidatesMatch![0];
    const localPos = candidates.indexOf(".env.local");
    const longFormPos = candidates.indexOf("longForm");
    const envPos = candidates.indexOf("'.env'");
    // .env.local before longForm before .env
    expect(localPos).toBeLessThan(longFormPos);
    expect(longFormPos).toBeLessThan(envPos);
  });

  it("should support long-form env names (.env.production, .env.development)", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain("production");
    expect(content).toContain("development");
  });

  it("should support short-form env names (.env.prod, .env.dev)", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain("'prod'");
    expect(content).toContain("'dev'");
  });

  it("should use override: false (first loaded wins)", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain("override: false");
  });

  it("should only log in dev mode", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain("env === 'dev'");
    // Should NOT have emojis
    expect(content).not.toContain("📄");
    expect(content).not.toContain("⚠️");
  });

  it("should export ENV constant", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain("export const ENV");
  });

  it("should normalize NODE_ENV to short form", async () => {
    const content = await readText(path.join(projectPath, "src/config/env.ts"));
    expect(content).toContain("normalizeEnv");
    // Should handle prod, production, test, qa, dev
    expect(content).toContain("'production'");
    expect(content).toContain("'test'");
    expect(content).toContain("'qa'");
  });
});

// ============================================================================
// config/index.ts template
// ============================================================================

describe("config/index.ts template", () => {
  it("should define AppConfig interface (TypeScript)", async () => {
    const content = await readText(
      path.join(projectPath, "src/config/index.ts"),
    );
    expect(content).toContain("interface AppConfig");
  });

  it("should read PORT from env with default", async () => {
    const content = await readText(
      path.join(projectPath, "src/config/index.ts"),
    );
    expect(content).toContain("process.env.PORT");
    expect(content).toContain("8040");
  });

  it("should read HOST from env with default", async () => {
    const content = await readText(
      path.join(projectPath, "src/config/index.ts"),
    );
    expect(content).toContain("process.env.HOST");
    expect(content).toContain("0.0.0.0");
  });

  it("should have isDev and isProd helpers", async () => {
    const content = await readText(
      path.join(projectPath, "src/config/index.ts"),
    );
    expect(content).toContain("isDev");
    expect(content).toContain("isProd");
  });

  it("should handle CORS_ORIGINS with wildcard support", async () => {
    const content = await readText(
      path.join(projectPath, "src/config/index.ts"),
    );
    // Should check for '*' and convert to boolean true
    expect(content).toContain("CORS_ORIGINS");
    expect(content).toContain("'*'");
    expect(content).toContain("split");
  });

  it("should have Better Auth config (for BA projects)", async () => {
    const content = await readText(
      path.join(projectPath, "src/config/index.ts"),
    );
    expect(content).toContain("BETTER_AUTH_SECRET");
    expect(content).toContain("FRONTEND_URL");
  });

  it("should have database config for MongoKit projects", async () => {
    const content = await readText(
      path.join(projectPath, "src/config/index.ts"),
    );
    expect(content).toContain("MONGODB_URI");
  });

  it("should export default config", async () => {
    const content = await readText(
      path.join(projectPath, "src/config/index.ts"),
    );
    expect(content).toContain("export default config");
  });
});

// ============================================================================
// .gitignore template
// ============================================================================

describe(".gitignore template", () => {
  it("should gitignore .env.local", async () => {
    const content = await readText(path.join(projectPath, ".gitignore"));
    expect(content).toContain(".env.local");
  });

  it("should gitignore .env.*.local", async () => {
    const content = await readText(path.join(projectPath, ".gitignore"));
    expect(content).toContain(".env.*.local");
  });

  it("should gitignore coverage/", async () => {
    const content = await readText(path.join(projectPath, ".gitignore"));
    expect(content).toContain("coverage/");
  });

  it("should gitignore node_modules/", async () => {
    const content = await readText(path.join(projectPath, ".gitignore"));
    expect(content).toContain("node_modules/");
  });

  it("should gitignore dist/", async () => {
    const content = await readText(path.join(projectPath, ".gitignore"));
    expect(content).toContain("dist/");
  });

  it("should NOT force-gitignore .env (shared defaults)", async () => {
    const content = await readText(path.join(projectPath, ".gitignore"));
    // .env should be commented out or not present as a standalone entry
    const lines = content.split("\n").map((l) => l.trim());
    const envLine = lines.find((l) => l === ".env");
    expect(envLine).toBeUndefined();
  });
});

// ============================================================================
// .env.example template
// ============================================================================

describe(".env.example template", () => {
  it("should document env file priority", async () => {
    const content = await readText(path.join(projectPath, ".env.example"));
    expect(content).toContain(".env.local");
    expect(content).toContain("priority");
  });

  it("should have all required env vars", async () => {
    const content = await readText(path.join(projectPath, ".env.example"));
    expect(content).toContain("PORT");
    expect(content).toContain("NODE_ENV");
    expect(content).toContain("BETTER_AUTH_SECRET");
    expect(content).toContain("MONGODB_URI");
    expect(content).toContain("CORS_ORIGINS");
  });
});
