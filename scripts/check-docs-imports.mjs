/**
 * Docs imports gate: every `import { ... } from '@classytic/arc[/subpath]'` in docs/**\/*.mdx,
 * README.md and examples/**\/*.ts names an export that api-surface.json lists for that subpath.
 * Same rule as check-skills.mjs (shared via `arcImportProblems`), applied to host-facing docs.
 *
 * Opt-out for a deliberate "bad example": end the import line with the comment
 * `check-docs-imports: ignore`. Zero deps.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { arcImportProblems } from "./check-skills.mjs";

const IGNORE = /check-docs-imports:\s*ignore/;
const SKIP_DIRS = new Set(["node_modules", "dist"]);

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

export function checkDocsImports(root = resolve(fileURLToPath(new URL("..", import.meta.url)))) {
  const surface = JSON.parse(readFileSync(join(root, "api-surface.json"), "utf8"));
  const files = [
    ...(existsSync(join(root, "docs")) ? walk(join(root, "docs")).filter((f) => f.endsWith(".mdx")) : []),
    ...(existsSync(join(root, "README.md")) ? [join(root, "README.md")] : []),
    ...(existsSync(join(root, "examples")) ? walk(join(root, "examples")).filter((f) => f.endsWith(".ts")) : []),
  ];
  const failures = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    for (const p of arcImportProblems(readFileSync(file, "utf8"), surface, IGNORE)) {
      failures.push(`${rel}:${p.line}: ${p.message}`);
    }
  }
  return { failures, scanned: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, scanned } = checkDocsImports();
  if (failures.length > 0) {
    console.error(`[check-docs-imports] ${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`[check-docs-imports] OK: every @classytic/arc import in ${scanned} docs/README/example file(s) exists`);
}
