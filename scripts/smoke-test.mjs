#!/usr/bin/env node
/**
 * Post-build smoke test — validates the packed artifact before publish.
 * Cross-platform (no bash dependency).
 *
 * Phase 3 ("subpath imports") enumerates EVERY entry in `package.json#exports`
 * — not a hand-curated subset — so a new entry added to `package.json` is
 * verified automatically. Catches "the export points at a path that doesn't
 * exist in dist" before publish.
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  [pass] ${label}`);
  } catch (e) {
    console.log(`  [FAIL] ${label}: ${e.message}`);
    failures++;
  }
}

console.log("=== Arc Smoke Test ===\n");

// 1. Critical dist files
console.log("[1/5] Checking dist artifacts...");
const criticalFiles = [
  "dist/index.mjs",
  "dist/index.d.mts",
  "dist/factory/index.mjs",
  "dist/factory/index.d.mts",
  "dist/scope/index.mjs",
  "dist/permissions/index.mjs",
  "dist/cli/commands/doctor.mjs",
  "dist/presets/index.mjs",
  "dist/presets/search.mjs",
  "dist/presets/search.d.mts",
  "dist/presets/filesUpload.mjs",
  "dist/presets/multiTenant.mjs",
];
for (const f of criticalFiles) {
  check(f, () => {
    if (!existsSync(f)) throw new Error("Missing");
  });
}

// 2. CLI smoke
console.log("\n[2/5] Testing CLI...");
check("arc --help", () => {
  execSync("node bin/arc.js --help", { stdio: "pipe" });
});

// 3. Subpath imports — enumerate every entry in package.json#exports
//
// Each entry has a `default` (the .mjs runtime artifact) and a `types`
// (the .d.mts declaration). We import-resolve the runtime artifact for
// every entry, and exists-check both. Catches "package.json points at a
// path that doesn't exist in dist" before publish — the most common
// silent breakage when a new subpath is added or renamed.
//
// Documented runtime-import exceptions: subpaths that intentionally
// require a host runtime context (e.g. vitest globals) to load. We still
// exists-check the artifact + types files for these — only the import
// resolution is skipped.
const IMPORT_SKIP_REASONS = {
  "./testing": "imports vitest globals — only loadable inside a test runner",
  "./testing/storage": "imports vitest globals — only loadable inside a test runner",
};

console.log("\n[3/5] Testing every package.json#exports subpath...");
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const exportEntries = Object.entries(pkg.exports ?? {})
  // Skip non-subpath entries (`./package.json` returns a JSON string,
  // not a module — we don't import-resolve it).
  .filter(([key, value]) => key !== "./package.json" && typeof value === "object" && value !== null);

for (const [subpath, target] of exportEntries) {
  const runtime = target.default ?? target.import ?? target.require;
  const types = target.types;
  const skipImport = IMPORT_SKIP_REASONS[subpath];

  if (runtime) {
    const relative = runtime.startsWith("./") ? runtime : `./${runtime}`;
    const label = skipImport
      ? `${subpath} → ${runtime} (artifact only — ${skipImport})`
      : `${subpath} → ${runtime}`;
    check(label, () => {
      if (!existsSync(runtime.replace(/^\.\//, ""))) {
        throw new Error(`runtime artifact missing: ${runtime}`);
      }
      if (!skipImport) {
        // Resolve the import — catches syntax errors, missing transitive
        // imports, and ESM specifier issues.
        execSync(`node -e "import('${relative}')"`, { stdio: "pipe" });
      }
    });
  }

  if (types) {
    check(`${subpath}[types] → ${types}`, () => {
      if (!existsSync(types.replace(/^\.\//, ""))) {
        throw new Error(`types artifact missing: ${types}`);
      }
    });
  }
}
console.log(`         (${exportEntries.length} subpath entries verified)`);

// 4. Pack check
console.log("\n[4/5] Checking npm pack...");
check("npm pack --dry-run", () => {
  const output = execSync("npm pack --dry-run 2>&1", { encoding: "utf-8" });
  const lastLine = output.trim().split("\n").pop();
  console.log(`         ${lastLine}`);
});

// 5. Real consumer install (file:../..) — proves the published artifact actually works
// Skipped on `npm run smoke` (fast iteration). Enforced via SMOKE_CONSUMER=1 or prepublishOnly.
if (process.env.SMOKE_CONSUMER === "1" || process.env.npm_lifecycle_event === "prepublishOnly") {
  console.log("\n[5/5] Running consumer install + e2e (file:../..)...");
  check("examples/_consumer-smoke", () => {
    // Clean install — file: deps don't update on plain `npm install` reliably
    execSync("npm install --no-audit --no-fund --silent", {
      cwd: "examples/_consumer-smoke",
      stdio: "pipe",
    });
    execSync("npm test --silent", {
      cwd: "examples/_consumer-smoke",
      stdio: "inherit",
    });
  });
} else {
  console.log("\n[5/5] Skipping consumer install (set SMOKE_CONSUMER=1 to enable)");
}

console.log(`\n=== Smoke Test ${failures === 0 ? "Passed" : `Failed (${failures})`} ===`);
if (failures > 0) process.exit(1);
