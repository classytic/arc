/**
 * Arc CLI - Doctor Health Check Tests
 *
 * Tests that `arc doctor` correctly identifies:
 * - Node.js version (pass/fail)
 * - Arc dependency (pass/warn)
 * - Fastify version (pass/fail)
 * - tsconfig.json (pass/warn)
 * - Optional peer deps (pass/warn)
 * - Environment variables (pass/warn)
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { doctor } from "../../src/cli/commands/doctor.js";

let testRoot: string;

beforeAll(async () => {
  testRoot = path.join(
    tmpdir(),
    `arc-cli-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

// Helper to capture console.log output
function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  return {
    logs,
    restore: () => {
      console.log = originalLog;
    },
  };
}

// ============================================================================
// Healthy Project (all passes)
// ============================================================================

describe("arc doctor — healthy project", () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = path.join(testRoot, "healthy");
    await fs.mkdir(projectDir, { recursive: true });

    // Create a package.json with all deps
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@classytic/arc": "^2.3.0",
          fastify: "^5.8.4",
          "@fastify/rate-limit": "^10.0.0",
          "@fastify/helmet": "^13.0.0",
          "@fastify/cors": "^11.0.0",
          "better-auth": "^1.5.5",
        },
      }),
    );

    // Create valid tsconfig
    await fs.writeFile(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          moduleResolution: "NodeNext",
        },
      }),
    );
  });

  it("should pass all checks for a well-configured project", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalEnv = { ...process.env };

    // Set env vars that doctor checks
    process.env.MONGO_URI = "mongodb://localhost:27017/test";
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-chars-long-here";
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      // Restore env
      delete process.env.MONGO_URI;
      delete process.env.BETTER_AUTH_SECRET;
      Object.keys(process.env).forEach((k) => {
        if (!(k in originalEnv)) delete process.env[k];
      });
    }

    const output = capture.logs.join("\n");
    // Node.js check should pass (we're running on Node >= 22)
    expect(output).toContain("[pass]");
    expect(output).toContain("@classytic/arc");
    expect(output).toContain("fastify");
    expect(output).toContain("tsconfig.json found");
    expect(output).toContain("@fastify/rate-limit installed");
    expect(output).toContain("@fastify/helmet installed");
    expect(output).toContain("@fastify/cors installed");
    expect(output).toContain("better-auth");
    expect(output).toContain("MONGO_URI set");
    expect(output).toContain("0 failures");
  });
});

// ============================================================================
// Missing Dependencies
// ============================================================================

describe("arc doctor — missing dependencies", () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = path.join(testRoot, "missing-deps");
    await fs.mkdir(projectDir, { recursive: true });

    // Minimal package.json — missing fastify, arc, optional deps
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {},
      }),
    );
  });

  it("should warn about missing Arc dependency", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    expect(output).toContain("[warn]");
    expect(output).toContain("@classytic/arc not found");
  });

  it("should fail on missing Fastify", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    expect(output).toContain("[FAIL]");
    expect(output).toContain("fastify not found");
  });

  it("should warn about missing optional peer deps", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    expect(output).toContain("@fastify/rate-limit not installed");
    expect(output).toContain("@fastify/helmet not installed");
    expect(output).toContain("@fastify/cors not installed");
  });
});

// ============================================================================
// Fastify Version Check
// ============================================================================

describe("arc doctor — Fastify version validation", () => {
  it("should fail when Fastify version is too old", async () => {
    const projectDir = path.join(testRoot, "old-fastify");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          fastify: "^4.0.0",
        },
      }),
    );

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    expect(output).toContain("[FAIL]");
    expect(output).toContain("fastify");
    expect(output).toContain("required: ^5.0.0");
  });

  it("should pass when Fastify version is 5+", async () => {
    const projectDir = path.join(testRoot, "good-fastify");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          fastify: "^5.7.4",
        },
      }),
    );

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    expect(output).toMatch(/\[pass\].*fastify/);
  });
});

// ============================================================================
// tsconfig.json Checks
// ============================================================================

describe("arc doctor — tsconfig validation", () => {
  it("should warn about non-recommended moduleResolution", async () => {
    const projectDir = path.join(testRoot, "bad-tsconfig");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }));
    await fs.writeFile(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          moduleResolution: "node",
        },
      }),
    );

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    expect(output).toContain("[warn]");
    expect(output).toContain('moduleResolution "node"');
    expect(output).toContain("NodeNext");
  });

  it("should warn when tsconfig.json is missing", async () => {
    const projectDir = path.join(testRoot, "no-tsconfig");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }));

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    expect(output).toContain("[warn]");
    expect(output).toContain("tsconfig.json not found");
  });

  it("should pass with NodeNext moduleResolution", async () => {
    const projectDir = path.join(testRoot, "good-tsconfig");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }));
    await fs.writeFile(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          moduleResolution: "NodeNext",
        },
      }),
    );

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    expect(output).toMatch(/\[pass\].*tsconfig\.json found/);
  });
});

// ============================================================================
// Environment Variable Checks
// ============================================================================

describe("arc doctor — environment variables", () => {
  it("should warn when MONGO_URI is not set", async () => {
    const projectDir = path.join(testRoot, "no-env");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }));

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalMongoUri = process.env.MONGO_URI;
    delete process.env.MONGO_URI;
    delete process.env.BETTER_AUTH_SECRET;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      if (originalMongoUri) process.env.MONGO_URI = originalMongoUri;
    }

    const output = capture.logs.join("\n");
    expect(output).toContain("[warn]");
    expect(output).toContain("MONGO_URI not set");
    expect(output).toContain("BETTER_AUTH_SECRET not set");
  });
});

// ============================================================================
// Exit Code
// ============================================================================

describe("arc doctor — exit code", () => {
  it("should set exitCode to 1 when there are failures", async () => {
    const projectDir = path.join(testRoot, "failing");
    await fs.mkdir(projectDir, { recursive: true });
    // No package.json at all — fastify missing = FAIL
    await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }));

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
    }

    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });
});

// ============================================================================
// Summary Line
// ============================================================================

describe("arc doctor — summary output", () => {
  it("should print pass/warn/fail counts", async () => {
    const projectDir = path.join(testRoot, "summary");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@classytic/arc": "^2.3.0",
          fastify: "^5.8.4",
        },
      }),
    );
    await fs.writeFile(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { moduleResolution: "NodeNext" } }),
    );

    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    process.chdir(projectDir);

    const capture = captureConsoleLog();
    try {
      await doctor([]);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
    }

    const output = capture.logs.join("\n");
    // Should have a summary line with counts
    expect(output).toMatch(/\d+ passed, \d+ warnings, \d+ failures/);
  });
});
