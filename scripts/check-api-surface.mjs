#!/usr/bin/env node
/**
 * Public API surface snapshot — declaration-compatibility automation.
 *
 * Captures, per package subpath: its stability label, its RUNTIME export
 * names (from the built dist, via dynamic import), and its DECLARATION
 * export names (parsed from the emitted .d.mts). The snapshot
 * (`api-surface.json`) is committed; the check mode diffs the current
 * build against it:
 *
 *   - REMOVED name on a `stable` subpath  → FAIL (breaking — requires an
 *     intentional snapshot update in the same change, with a ⚠ changelog
 *     entry per the versioning policy in GOVERNANCE.md)
 *   - REMOVED name on `beta`/`experimental` → warn (allowed, listed)
 *   - ADDED name                            → warn (additive; update the
 *     snapshot to acknowledge)
 *
 * Run: node scripts/check-api-surface.mjs            (verify — prepublish)
 *      node scripts/check-api-surface.mjs --update   (regenerate snapshot)
 *
 * Requires a fresh `npm run build` — the surface is read from dist/.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "api-surface.json");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const stability = pkg.arc?.subpathStability ?? {};

/** Parse export names out of a rolldown-dts declaration file. */
function declarationExports(dtsPath) {
  let text;
  try {
    text = readFileSync(dtsPath, "utf8");
  } catch {
    return [];
  }
  const names = new Set();
  // `export { A, type B, C as D, ... }` blocks (possibly multiline).
  for (const block of text.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const raw of block[1].split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      const asMatch = /\s+as\s+(\w+)$/.exec(entry);
      const name = asMatch ? asMatch[1] : entry.replace(/^type\s+/, "").trim();
      if (/^\w+$/.test(name) && name !== "default") names.add(name);
    }
  }
  // Direct declarations exported inline.
  for (const m of text.matchAll(
    /export\s+declare\s+(?:function|class|const|let|interface|enum|type)\s+(\w+)/g,
  )) {
    names.add(m[1]);
  }
  return [...names].sort();
}

async function runtimeExports(distEntry) {
  try {
    const ns = await import(pathToFileURL(path.join(ROOT, distEntry)).href);
    return Object.keys(ns)
      .filter((k) => k !== "default")
      .sort();
  } catch (err) {
    // Some subpaths require peers absent in this environment — surface the
    // reason but don't fail snapshotting on optional-peer imports.
    return { unimportable: String(err?.message ?? err).split("\n")[0] };
  }
}

/**
 * Content hash of the declaration file (whitespace-normalized). Name-set
 * diffs can't see SIGNATURE changes (parameter types, generics, overloads,
 * optionality) — the hash turns any declaration edit into a visible,
 * classify-me signal without attempting a semantic diff. A future semantic
 * layer (API Extractor style) can replace it; this script stays the fast
 * first gate.
 */
function declarationHash(dtsPath) {
  try {
    const text = readFileSync(dtsPath, "utf8").replace(/\s+/g, " ").trim();
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

async function buildSurface() {
  const surface = {};
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (subpath === "./package.json") continue;
    const types = typeof target === "object" ? target.types : undefined;
    const entry = typeof target === "object" ? (target.default ?? target.import) : target;
    const runtime = entry ? await runtimeExports(entry) : [];
    surface[subpath] = {
      stability: stability[subpath] ?? "unlabelled",
      runtime,
      types: types ? declarationExports(path.join(ROOT, types)) : [],
      typesHash: types ? declarationHash(path.join(ROOT, types)) : null,
    };
  }
  return surface;
}

/** Runtime and type surfaces diff INDEPENDENTLY — a value demoted to a
 * type-only export must register as a runtime removal even though the name
 * survives in the declaration set. */
function diffSets(label, before, after) {
  const beforeSet = new Set(Array.isArray(before) ? before : []);
  const afterSet = new Set(Array.isArray(after) ? after : []);
  return {
    removed: [...beforeSet].filter((n) => !afterSet.has(n)).map((n) => `${n} [${label}]`),
    added: [...afterSet].filter((n) => !beforeSet.has(n)).map((n) => `${n} [${label}]`),
  };
}

const surface = await buildSurface();

if (process.argv.includes("--update")) {
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(surface, null, 2)}\n`);
  const total = Object.values(surface).reduce(
    (n, e) => n + (Array.isArray(e.runtime) ? e.runtime.length : 0) + e.types.length,
    0,
  );
  console.log(
    `✔ api-surface.json updated — ${Object.keys(surface).length} subpaths, ${total} exported names (runtime+types counted separately).`,
  );
  process.exit(0);
}

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  console.error("✖ api-surface.json missing — run `npm run api:surface` after a build.");
  process.exit(1);
}

const breaking = [];
const warnings = [];

for (const [subpath, snapEntry] of Object.entries(snapshot)) {
  const current = surface[subpath];
  if (!current) {
    breaking.push(`SUBPATH REMOVED: ${subpath} (${snapEntry.stability})`);
    continue;
  }
  const label = snapEntry.stability;
  const runtimeDiff = diffSets("runtime", snapEntry.runtime, current.runtime);
  const typesDiff = diffSets("types", snapEntry.types, current.types);
  const removed = [...runtimeDiff.removed, ...typesDiff.removed];
  const added = [...runtimeDiff.added, ...typesDiff.added];
  if (removed.length > 0) {
    const msg = `${subpath} (${label}) removed: ${removed.join(", ")}`;
    if (label === "stable") breaking.push(msg);
    else warnings.push(msg);
  }
  if (added.length > 0) warnings.push(`${subpath} added: ${added.join(", ")}`);
  // Same names, different declaration content ⇒ a SIGNATURE-level change
  // the name diff can't see (`timeout?: number` → `timeout: number` narrows
  // every caller). On STABLE subpaths this FAILS until acknowledged — the
  // acknowledgment is regenerating the snapshot in the same change (exactly
  // the name-removal contract) plus classifying it in the PR/changelog.
  // Beta/experimental report informationally.
  if (
    removed.length === 0 &&
    added.length === 0 &&
    snapEntry.typesHash &&
    current.typesHash &&
    snapEntry.typesHash !== current.typesHash
  ) {
    const msg =
      `${subpath} (${label}): declaration content changed with no name changes — ` +
      "signature/optionality/generics edit; classify it (additive widening vs breaking narrowing)";
    if (label === "stable") breaking.push(msg);
    else warnings.push(msg);
  }
}
for (const subpath of Object.keys(surface)) {
  if (!snapshot[subpath]) warnings.push(`NEW SUBPATH: ${subpath} — snapshot it`);
}

for (const w of warnings) console.log(`ℹ ${w}`);
if (breaking.length > 0) {
  console.error(`\n✖ Public API surface check failed (${breaking.length} breaking):\n`);
  for (const b of breaking) console.error(`  ${b}`);
  console.error(
    "\nIf intentional: update the snapshot (`npm run api:surface`), mark the change ⚠ in the changelog, and follow the deprecation policy in GOVERNANCE.md.",
  );
  process.exit(1);
}
console.log(
  `✔ Public API surface matches snapshot — ${Object.keys(surface).length} subpaths${warnings.length ? ` (${warnings.length} additive/informational notes)` : ""}.`,
);
