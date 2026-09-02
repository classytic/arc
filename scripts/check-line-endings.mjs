#!/usr/bin/env node
/**
 * Line-ending guard — CRLF in the WORKING TREE, which nothing else sees.
 *
 * ## Why `.gitattributes` does not cover this
 *
 * `* text=auto eol=lf` is already set and is correct: git writes LF on
 * checkout and normalizes to LF in the blob on commit. What it cannot do is
 * stop an editor or tool from writing CRLF into a file that is ALREADY checked
 * out. When that happens the blob stays LF, so `git status` and `git diff` show
 * nothing at all — the drift is invisible to every git-shaped check, and the
 * only warning is a passing mention that "CRLF will be replaced by LF the next
 * time Git touches it".
 *
 * ## Why `lint` does not cover it either
 *
 * Biome's formatter pins `lineEnding: "lf"`, so it DOES catch this — but the
 * gate runs `biome check src/`, and `lint:fix` is likewise `src/` only. Two
 * files drifted outside that scope (`tests/`, `skills/`) and were caught by
 * nothing. Markdown is worse: Biome does not format it, so a `.md` with CRLF is
 * invisible to every existing check in this repo.
 *
 * ## Why it earns a guard rather than a wider `biome` glob
 *
 * Two prepublish failures in one session (2026-09-02), and the second reported
 * itself as a ~1600-line character-by-character format diff that never used the
 * words "line endings". The cost was never the fix — it is one command — it was
 * recognising what the diff meant. This runs in milliseconds, needs no build,
 * names the files, and states the remedy.
 *
 * Run: node scripts/check-line-endings.mjs
 * Fix: node scripts/check-line-endings.mjs --fix
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const ROOTS = ["src", "tests", "scripts", "skills", "wiki", "changelog", "docs"];
const ROOT_FILES = ["CLAUDE.md", "AGENTS.md", "CHANGELOG.md", "README.md"];
const EXTS = new Set([".ts", ".mts", ".mjs", ".js", ".md", ".json"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

const FIX = process.argv.includes("--fix");
const offenders = [];
let scanned = 0;

function check(file) {
  const rel = path.relative(ROOT, file);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  scanned++;
  if (!text.includes("\r\n")) return;
  if (FIX) {
    writeFileSync(file, text.replace(/\r\n/g, "\n"), "utf8");
    offenders.push(`${rel} (fixed)`);
  } else {
    const n = text.split("\r\n").length - 1;
    offenders.push(`${rel} — ${n} CRLF line ending(s)`);
  }
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (EXTS.has(path.extname(entry.name))) check(full);
  }
}

for (const r of ROOTS) walk(path.join(ROOT, r));
for (const f of ROOT_FILES) {
  const full = path.join(ROOT, f);
  try {
    if (statSync(full).isFile()) check(full);
  } catch {
    /* optional file */
  }
}

if (offenders.length > 0 && !FIX) {
  console.error(`[check-line-endings] ${offenders.length} file(s) with CRLF in the working tree:\n`);
  for (const o of offenders) console.error(`  ✗ ${o}`);
  console.error(
    "\n  The committed blob is LF (`.gitattributes` handles that), so `git diff` shows\n" +
      "  NOTHING — this only ever surfaces as an unreadable whole-file format diff.\n" +
      "  Fix: node scripts/check-line-endings.mjs --fix\n",
  );
  process.exit(1);
}

if (FIX) {
  console.log(
    offenders.length > 0
      ? `[check-line-endings] normalized ${offenders.length} file(s) to LF:\n${offenders.map((o) => `  • ${o}`).join("\n")}`
      : `[check-line-endings] OK — ${scanned} file(s), nothing to fix.`,
  );
} else {
  console.log(`[check-line-endings] OK — ${scanned} file(s), all LF.`);
}
