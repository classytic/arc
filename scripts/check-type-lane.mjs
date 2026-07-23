#!/usr/bin/env node
/**
 * Type-lane coverage gate — every test file containing a compile-time
 * assertion (`expectTypeOf` or `@ts-expect-error`) must be part of the
 * `tsconfig.types.json` program. Vitest transpiles without type-checking,
 * so an assertion outside that program proves nothing; the include list is
 * maintained manually, and this check is what keeps it from drifting.
 *
 * Resolves the config's `include` entries with a minimal matcher (exact
 * file, or directory prefix globs containing a double-star) — the
 * installed compiler (tsgo / TypeScript 7) exposes no config-parsing API.
 *
 * Run: node scripts/check-type-lane.mjs   (part of `npm run typecheck`)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const config = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.types.json"), "utf8"));
const include = (config.include ?? []).map((entry) => entry.replaceAll("\\", "/"));

/** Does `relPath` (posix, repo-relative) match one of the include entries? */
function included(relPath) {
  for (const entry of include) {
    if (entry === relPath) return true;
    const globIndex = entry.indexOf("**");
    if (globIndex !== -1) {
      const prefix = entry.slice(0, globIndex).replace(/\/$/, "");
      if (relPath === prefix || relPath.startsWith(`${prefix}/`)) return true;
    }
  }
  return false;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.test(-d)?\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const ASSERTION = /expectTypeOf|@ts-expect-error/;
const missing = [];
let covered = 0;
for (const file of walk(path.join(ROOT, "tests"))) {
  if (!ASSERTION.test(readFileSync(file, "utf8"))) continue;
  const rel = path.relative(ROOT, file).replaceAll("\\", "/");
  if (included(rel)) covered++;
  else missing.push(rel);
}

if (missing.length > 0) {
  console.error(
    `✖ ${missing.length} file(s) contain compile-time assertions (expectTypeOf / @ts-expect-error) ` +
      "but are NOT compiled by tsconfig.types.json — their assertions prove nothing:\n",
  );
  for (const f of missing) console.error(`  ${f}`);
  console.error(
    '\nAdd each file to the "include" list in tsconfig.types.json (or move the assertions into tests/types/).',
  );
  process.exit(1);
}
console.log(
  `✔ Type-lane coverage — all ${covered} compile-assertion test files are in the tsconfig.types.json program.`,
);
