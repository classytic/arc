#!/usr/bin/env node
/**
 * Removed-route-API gate.
 *
 * `RouteDefinition.raw` was removed in 2.31 (the `handler` / `rawHandler`
 * split). `tsc` catches a leftover flag in arc's own `src/`, and `biome` never
 * looks at prose — so the places it actually rots are exactly the ones neither
 * tool reads:
 *
 *   - CLI templates, which are backtick STRINGS: the compiler type-checks the
 *     template, not the app it emits. `arc init` shipped seven routes using the
 *     removed flag past a green typecheck and a green scaffold suite (which
 *     asserts that generated files contain certain strings, not that they
 *     compile).
 *   - `docs/`, `skills/`, `wiki/`, `examples/` — read by humans and agents, who
 *     then write host code against an API that no longer exists.
 *
 * Historical release notes are allowlisted: `changelog/` MUST keep saying
 * `raw: true` to describe what changed, and so must the few passages that
 * explicitly name the removal.
 *
 * Run: node scripts/check-removed-route-api.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

/** Scanned roots — everything that teaches or emits route definitions. */
const SCAN = ["src", "docs", "skills", "wiki", "examples", "tests", "README.md", "AGENTS.md"];

/** Release history describes the removal by name; that is its job. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "changelog", "_consumer-smoke"]);
const SKIP_FILES = new Set(["CHANGELOG.md", "v3.md"]);

/**
 * Comment lines MENTION the removal rather than use it — explaining why the
 * flag is fatal, or what a stale dependency still emits. A route definition is
 * never a comment, so skipping them costs no coverage: the `arc init` template
 * bug this gate exists to catch was a bare `raw: true,` in emitted code.
 */
const COMMENT = /^\s*(\*|\/\/|<!--)/;

/**
 * Explicit opt-out for the handful of places that must USE the removed shape —
 * the test proving arc rejects it. Deliberately verbose so it can't be pasted
 * in casually.
 */
const ALLOW_MARKER = "arc:allow-removed-raw";

/** Route-level `raw` flag in code or prose. */
const PATTERN = /\braw:\s*(true|false)\b/;

const EXTS = /\.(ts|mts|js|mjs|md|mdx)$/;

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (EXTS.test(entry)) yield full;
  }
}

const hits = [];
for (const target of SCAN) {
  const full = path.join(ROOT, target);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    continue; // optional target
  }
  const list = stat.isDirectory() ? files(full) : [full];
  for (const file of list) {
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (!PATTERN.test(line)) return;
        if (COMMENT.test(line) || line.includes(ALLOW_MARKER)) return;
        hits.push({ rel, line: i + 1, text: line.trim().slice(0, 100) });
      });
  }
}

if (hits.length > 0) {
  console.error(`\n✖ Removed route API in use (${hits.length}):\n`);
  for (const h of hits) console.error(`  ${h.rel}:${h.line}\n      ${h.text}`);
  console.error(
    "\n`RouteDefinition.raw` was removed in 2.31. Put the function in `rawHandler`" +
      " (Fastify-native `(request, reply)`) or `handler` (arc pipeline, `(ctx)`),\n" +
      "and delete the flag. Release notes describing the removal are allowlisted.\n",
  );
  process.exit(1);
}

console.log("✔ No use of the removed `RouteDefinition.raw` flag.");
