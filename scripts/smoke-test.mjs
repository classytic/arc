#!/usr/bin/env node
/**
 * Post-build smoke test — validates the packed artifact before publish.
 * Cross-platform (no bash dependency).
 */

import { existsSync } from "node:fs";
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

// 3. Subpath imports
console.log("\n[3/5] Testing subpath imports...");
const imports = [
  ["dist/index.mjs", "./dist/index.mjs"],
  ["dist/factory/index.mjs", "./dist/factory/index.mjs"],
  ["dist/scope/index.mjs", "./dist/scope/index.mjs"],
  ["dist/permissions/index.mjs", "./dist/permissions/index.mjs"],
];
for (const [label, path] of imports) {
  check(label, () => {
    execSync(`node -e "import('${path}')"`, { stdio: "pipe" });
  });
}

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
