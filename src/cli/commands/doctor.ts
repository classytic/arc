/**
 * Arc CLI - Doctor Command
 *
 * Health check utility that validates the development environment.
 * Checks Node.js version, dependencies, configuration, and env variables.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

interface CheckResult {
  status: "pass" | "warn" | "fail";
  label: string;
  detail?: string;
}

export async function doctor(_args: string[] = []): Promise<void> {
  console.log("\nArc Doctor\n");

  const results: CheckResult[] = [];
  const cwd = process.cwd();

  // 1. Node.js version
  const nodeVersion = process.versions.node;
  const nodeMajor = parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  if (nodeMajor >= 22) {
    results.push({ status: "pass", label: `Node.js ${nodeVersion}`, detail: "required: >=22" });
  } else {
    results.push({ status: "fail", label: `Node.js ${nodeVersion}`, detail: "required: >=22" });
  }

  // 2. Find nearest package.json
  const pkg = findPackageJson(cwd);
  const allDeps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };

  // 3. Arc version
  const arcVersion = allDeps["@classytic/arc"];
  if (arcVersion) {
    results.push({ status: "pass", label: `@classytic/arc ${arcVersion}` });
  } else {
    results.push({ status: "warn", label: "@classytic/arc not found in dependencies" });
  }

  // 4. Fastify version
  const fastifyVersion = allDeps.fastify;
  if (fastifyVersion) {
    const clean = fastifyVersion.replace(/^[\^~>=<]+/, "").split("-")[0] ?? "0.0.0";
    const major = parseInt(clean.split(".")[0] ?? "0", 10);
    if (major >= 5) {
      results.push({
        status: "pass",
        label: `fastify ${fastifyVersion}`,
        detail: "required: ^5.0.0",
      });
    } else {
      results.push({
        status: "fail",
        label: `fastify ${fastifyVersion}`,
        detail: "required: ^5.0.0 — Arc requires Fastify 5",
      });
    }
  } else {
    results.push({
      status: "fail",
      label: "fastify not found in dependencies",
      detail: "required: ^5.0.0",
    });
  }

  // 5. tsconfig.json
  const tsconfigPath = resolve(cwd, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      const raw = readFileSync(tsconfigPath, "utf-8");
      // Strip single-line comments for JSON parsing
      const stripped = raw.replace(/\/\/.*$/gm, "");
      const tsconfig = JSON.parse(stripped);
      const moduleRes = tsconfig?.compilerOptions?.moduleResolution;
      if (moduleRes && !["nodenext", "node16", "bundler"].includes(moduleRes.toLowerCase())) {
        results.push({
          status: "warn",
          label: "tsconfig.json found",
          detail: `moduleResolution "${moduleRes}" — recommend "NodeNext" or "Bundler"`,
        });
      } else {
        results.push({ status: "pass", label: "tsconfig.json found" });
      }
    } catch {
      results.push({ status: "pass", label: "tsconfig.json found" });
    }
  } else {
    results.push({ status: "warn", label: "tsconfig.json not found" });
  }

  // 6. Peer / optional dependencies
  const optionalDeps: Array<{ name: string; purpose: string }> = [
    { name: "@fastify/rate-limit", purpose: "rate limiting" },
    { name: "@fastify/helmet", purpose: "security headers" },
    { name: "@fastify/cors", purpose: "CORS support" },
  ];

  for (const dep of optionalDeps) {
    if (allDeps[dep.name]) {
      results.push({ status: "pass", label: `${dep.name} installed` });
    } else {
      results.push({
        status: "warn",
        label: `${dep.name} not installed`,
        detail: `${dep.purpose} disabled`,
      });
    }
  }

  // 7. Better Auth detection
  if (allDeps["better-auth"]) {
    results.push({ status: "pass", label: `better-auth ${allDeps["better-auth"]}` });
  }

  // 8. Environment variables
  const envChecks: Array<{ name: string; severity: "warn" | "fail"; detail: string }> = [
    { name: "MONGO_URI", severity: "warn", detail: "required at runtime for MongoDB" },
    {
      name: "BETTER_AUTH_SECRET",
      severity: "warn",
      detail: "required for Better Auth session encryption",
    },
  ];

  for (const env of envChecks) {
    if (process.env[env.name]) {
      results.push({ status: "pass", label: `${env.name} set` });
    } else {
      results.push({ status: env.severity, label: `${env.name} not set`, detail: env.detail });
    }
  }

  // Print results
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const r of results) {
    const icon = r.status === "pass" ? "[pass]" : r.status === "warn" ? "[warn]" : "[FAIL]";
    const detail = r.detail ? ` (${r.detail})` : "";
    console.log(`  ${icon} ${r.label}${detail}`);

    if (r.status === "pass") passCount++;
    else if (r.status === "warn") warnCount++;
    else failCount++;
  }

  console.log(`\n${passCount} passed, ${warnCount} warnings, ${failCount} failures\n`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

function findPackageJson(dir: string): Record<string, Record<string, string>> | null {
  // Walk up the directory tree until we find package.json or hit the root
  let current = resolve(dir);
  const root = parse(current).root;

  while (current !== root) {
    const p = join(current, "package.json");
    try {
      if (existsSync(p)) {
        return JSON.parse(readFileSync(p, "utf-8"));
      }
    } catch {
      // Skip unreadable files
    }
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return null;
}
