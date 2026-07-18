#!/usr/bin/env node
/**
 * Dependency-boundary gate for src/ — machine-enforced architecture.
 *
 * Two checks, zero dependencies:
 *
 *  1. LAYERS — every top-level `src/<module>` is assigned a layer; imports
 *     may only point at modules in the SAME or a LOWER layer. New modules
 *     must be added to LAYERS explicitly (unknown modules fail the gate),
 *     so the map can't silently rot.
 *  2. CYCLES — no import cycles between top-level modules, EXCEPT pairs
 *     listed in KNOWN_CYCLES (pre-existing, tracked for burn-down; a new
 *     cycle fails immediately).
 *
 * Run: node scripts/check-boundaries.mjs           (verify — CI/prepublish)
 *      node scripts/check-boundaries.mjs --graph   (print the module graph)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SRC = path.resolve(process.cwd(), "src");

/**
 * Layer map — lower number = more foundational. An import from module A to
 * module B is legal iff layer(B) <= layer(A). Same-layer imports are legal
 * (cycle detection still applies).
 */
const LAYERS = {
  // 0 — leaf primitives: no arc-internal imports beyond each other
  constants: 0,
  logger: 0,
  context: 0,
  schemas: 0,
  migrations: 0,
  sync: 0,
  discovery: 0,
  // 1 — shared vocabulary + identity
  types: 1,
  scope: 1,
  utils: 1,
  encryption: 1,
  // 2 — policy + request plumbing
  permissions: 2,
  pipeline: 2,
  middleware: 2,
  hooks: 2,
  cache: 2,
  idempotency: 2,
  events: 2,
  audit: 2,
  usage: 2,
  scim: 2,
  // 3 — resource execution kernel
  core: 3,
  presets: 3,
  docs: 3,
  registry: 3,
  auth: 3,
  // 4 — delivery surfaces + infrastructure plugins
  plugins: 4,
  integrations: 4,
  // 5 — composition roots + tooling
  factory: 5,
  testing: 5,
  cli: 5,
};

/**
 * Grandfathered upward edges, tracked for burn-down. Each is a deliberate
 * public-surface decision (barrel re-export) or a helper-placement debt —
 * NOT a license for new upward imports. Removing an entry once the edge is
 * untangled is the goal; adding one requires a design conversation.
 * Grandfathered edges are excluded from both the layer check and cycle
 * detection (they'd otherwise explain every composite cycle they sit on).
 */
const GRANDFATHERED_EDGES = new Map([
  // `@classytic/arc/utils` re-exports validateResourceConfig from core —
  // public-surface decision from v2.11.0 ("root = essentials only").
  ["utils -> core", "barrel re-export of core/validateResourceConfig"],
  // `@classytic/arc` (factory barrel) re-exports preloadResources from
  // testing for DX autocomplete next to loadResources.
  ["factory -> testing", "barrel re-export of testing/preloadResources"],
  // scope/elevation + resolveOrgFromHeader use getUserRoles/normalizeRoles
  // from permissions/types. Burn-down: move the role-normalization helpers
  // into scope (or a lower module) and re-export from permissions.
  ["scope -> permissions", "getUserRoles/normalizeRoles helper placement"],
]);

// ── graph construction ──────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function topModule(absFile) {
  const rel = path.relative(SRC, absFile);
  if (rel.startsWith("..")) return null;
  const seg = rel.split(path.sep)[0];
  return seg.includes(".") ? null : seg; // root-level src/*.ts files are unowned
}

/**
 * RUNTIME imports only. `import type` / `export type` are erased by tsc and
 * cannot create module-initialization cycles, so they don't gate. Dynamic
 * `import("...")` is skipped too: in this codebase it's overwhelmingly
 * type-position (`import("../x.js").Foo`), and genuine runtime dynamic
 * imports are deferred — they can't create load-time cycles by construction.
 */
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)[^"'()]*?from\s+["'](\.[^"']+)["']/gm;

const files = walk(SRC);
/** Map<fromModule, Map<toModule, Set<exampleFile>>> */
const graph = new Map();

for (const file of files) {
  const fromMod = topModule(file);
  if (!fromMod || !(fromMod in LAYERS)) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(IMPORT_RE)) {
    const resolved = path.resolve(path.dirname(file), match[1]);
    const toMod = topModule(resolved);
    if (!toMod || toMod === fromMod) continue;
    if (!graph.has(fromMod)) graph.set(fromMod, new Map());
    const edges = graph.get(fromMod);
    if (!edges.has(toMod)) edges.set(toMod, new Set());
    if (edges.get(toMod).size < 3) {
      edges.get(toMod).add(`${path.relative(SRC, file)} → ${match[1]}`);
    }
  }
}

// ── checks ──────────────────────────────────────────────────────────────

const errors = [];

// Unknown modules — force the layer map to stay current.
for (const entry of readdirSync(SRC)) {
  const full = path.join(SRC, entry);
  if (statSync(full).isDirectory() && !(entry in LAYERS)) {
    errors.push(`src/${entry}/ is not in the LAYERS map — assign it a layer in scripts/check-boundaries.mjs`);
  }
}

// Prune grandfathered edges (tracked separately) before layer/cycle checks.
const usedGrandfathers = new Set();
for (const [fromMod, edges] of graph) {
  for (const toMod of [...edges.keys()]) {
    const key = `${fromMod} -> ${toMod}`;
    if (GRANDFATHERED_EDGES.has(key)) {
      usedGrandfathers.add(key);
      edges.delete(toMod);
    }
  }
}

// Layer violations.
for (const [fromMod, edges] of graph) {
  for (const [toMod, examples] of edges) {
    if (!(toMod in LAYERS)) continue;
    if (LAYERS[toMod] > LAYERS[fromMod]) {
      errors.push(
        `LAYER: ${fromMod} -> ${toMod} (layer ${LAYERS[fromMod]} → ${LAYERS[toMod]}) e.g.\n    ${[...examples].join("\n    ")}`,
      );
    }
  }
}

// Cycle detection between top-level modules via DFS over the pruned graph.
const seenCycles = new Set();
function findCycles(node, stack, visited) {
  visited.add(node);
  stack.push(node);
  for (const next of graph.get(node)?.keys() ?? []) {
    const idx = stack.indexOf(next);
    if (idx !== -1) {
      seenCycles.add([...stack.slice(idx), next].join(" → "));
    } else if (!visited.has(next)) {
      findCycles(next, stack, visited);
    }
  }
  stack.pop();
}
{
  const visited = new Set();
  for (const node of graph.keys()) if (!visited.has(node)) findCycles(node, [], visited);
}
for (const key of seenCycles) {
  errors.push(`CYCLE: ${key} — runtime import cycle between top-level modules`);
}

// ── output ──────────────────────────────────────────────────────────────

if (process.argv.includes("--graph")) {
  for (const [fromMod, edges] of [...graph].sort()) {
    console.log(`${fromMod} (L${LAYERS[fromMod]}) → ${[...edges.keys()].sort().join(", ")}`);
  }
  process.exit(0);
}

const staleKnown = [...GRANDFATHERED_EDGES.keys()].filter((k) => !usedGrandfathers.has(k));
if (staleKnown.length > 0) {
  console.log(`ℹ GRANDFATHERED_EDGES no longer present (remove them): ${staleKnown.join(", ")}`);
}

if (errors.length > 0) {
  console.error(`✖ Dependency-boundary check failed (${errors.length}):\n`);
  for (const err of errors) console.error(`  ${err}\n`);
  process.exit(1);
}
console.log(
  `✔ Dependency boundaries hold — ${files.length} files, ${graph.size} modules, ${usedGrandfathers.size} grandfathered edges pending burn-down.`,
);
