/**
 * Arc CLI - Doctor Command
 *
 * Health check utility that validates the development environment.
 * Checks Node.js version, dependencies, configuration, the env variables the
 * project's own dependencies and `.env.example` imply, and static notes
 * (proxy trust, readiness checks). Static only: it never boots the app.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

interface CheckResult {
  /** `info` is a note: printed, never counted as a warning or failure. */
  status: "pass" | "warn" | "fail" | "info";
  label: string;
  detail?: string;
}

/**
 * Env vars implied by an installed dependency. `names[0]` is the one reported; any of `names`
 * counts as set.
 */
const ENV_BY_DEPENDENCY: ReadonlyArray<{ deps: string[]; names: string[]; detail: string }> = [
  {
    deps: ["better-auth"],
    names: ["BETTER_AUTH_SECRET"],
    detail: "required for Better Auth session encryption",
  },
  {
    deps: ["@classytic/mongokit", "mongoose", "mongodb"],
    names: ["MONGO_URI", "MONGODB_URI", "DATABASE_URL"],
    detail: "required at runtime for MongoDB",
  },
  {
    deps: ["ioredis", "bullmq"],
    names: ["REDIS_URL"],
    detail: "required at runtime for Redis",
  },
];

const ENV_TEMPLATES = [".env.example", ".env.sample", ".env.template"];

/** `KEY=` names from a dotenv-style file; empty when it is absent. */
function readEnvKeys(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf-8")
      .split(/\r?\n/)
      .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((k): k is string => k !== undefined);
  } catch {
    return [];
  }
}

/**
 * Env checks derived from the project, not a fixed list: a var is checked when an installed
 * dependency needs it, or when the project's `.env.example` declares it. A var counts as set
 * when it is in the environment or in `./.env` (doctor never boots or loads the app).
 */
function envChecks(allDeps: Record<string, string>, cwd: string): CheckResult[] {
  const configured = new Set(readEnvKeys(resolve(cwd, ".env")));
  const isSet = (name: string) => Boolean(process.env[name]) || configured.has(name);
  const out: CheckResult[] = [];
  const covered = new Set<string>();

  for (const rule of ENV_BY_DEPENDENCY) {
    const dep = rule.deps.find((d) => allDeps[d]);
    if (!dep) continue;
    for (const n of rule.names) covered.add(n);
    const found = rule.names.find(isSet);
    if (found) {
      out.push({ status: "pass", label: `${found} set` });
    } else {
      const also = rule.names.slice(1);
      out.push({
        status: "warn",
        label: `${rule.names[0]} not set`,
        detail: `${rule.detail} (${dep} installed)${also.length ? `; also accepted: ${also.join(", ")}` : ""}`,
      });
    }
  }

  const template = ENV_TEMPLATES.find((f) => existsSync(resolve(cwd, f)));
  if (template) {
    for (const name of readEnvKeys(resolve(cwd, template))) {
      if (covered.has(name)) continue;
      covered.add(name);
      if (!isSet(name)) {
        out.push({ status: "warn", label: `${name} not set`, detail: `declared in ${template}` });
      }
    }
  }
  return out;
}

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const MAX_SCANNED_FILES = 2000;

/** Concatenated source text under `src/` (or the project root), skipping node_modules/dist. */
function readProjectSource(cwd: string): string {
  const root = existsSync(resolve(cwd, "src")) ? resolve(cwd, "src") : cwd;
  const chunks: string[] = [];
  const stack = [root];
  while (stack.length > 0 && chunks.length < MAX_SCANNED_FILES) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (SOURCE_EXTENSIONS.test(e.name)) {
        try {
          chunks.push(readFileSync(full, "utf-8"));
        } catch {
          // unreadable — skip
        }
      }
    }
  }
  return chunks.join("\n");
}

/** Static notes arc cannot decide at boot: proxy trust and empty readiness. */
function sourceNotes(cwd: string): CheckResult[] {
  const source = readProjectSource(cwd);
  if (!/createApp|createWorker/.test(source)) return [];
  const notes: CheckResult[] = [];
  if (!/\btrustProxy\b/.test(source)) {
    notes.push({
      status: "info",
      label: "trustProxy not set in source",
      detail:
        "preset 'production' defaults to false; behind a load balancer request.ip is then the proxy's address (rate limits, audit). Set it explicitly",
    });
  }
  if (!/\bhealthChecks\b|\bchecks\s*:/.test(source)) {
    notes.push({
      status: "info",
      label: "no readiness checks found in source",
      detail:
        "/_health/ready can never report not_ready; add module healthChecks or arcPlugins.health.checks",
    });
  }
  return notes;
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

  // 8. Environment variables — only what this project installs or declares
  results.push(...envChecks(allDeps, cwd));

  // 9. Notes from a static scan of the project's source (no boot)
  results.push(...sourceNotes(cwd));

  // Print results
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const r of results) {
    const icon =
      r.status === "pass"
        ? "[pass]"
        : r.status === "warn"
          ? "[warn]"
          : r.status === "info"
            ? "[info]"
            : "[FAIL]";
    const detail = r.detail ? ` (${r.detail})` : "";
    console.log(`  ${icon} ${r.label}${detail}`);

    if (r.status === "pass") passCount++;
    else if (r.status === "warn") warnCount++;
    else if (r.status === "fail") failCount++;
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
