/**
 * Release gate: contributor docs must state the SAME peer floors as
 * package.json.
 *
 * The 2.22 doc sweep found primitives/repo-core floors rotted at
 * 2.16-era values in TWO quick-reference files (CLAUDE.md and
 * wiki/peer-deps.md) across two releases — every agent reading the
 * quick-ref would have recommended wrong floors to hosts. Same fix
 * class as check-peer-skew: make the drift structurally impossible
 * instead of relying on sweep discipline.
 *
 * Checks every `| <pkg> | >=x.y.z |` table row in the watched docs
 * against peerDependencies. Docs may list fewer peers than
 * package.json (tables stay curated); they may not list WRONG ones.
 *
 * Wired into `prepublishOnly`. Zero deps.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WATCHED_DOCS = ["CLAUDE.md", "wiki/peer-deps.md"];

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const peers = pkg.peerDependencies ?? {};

// Matches table rows like: | @classytic/repo-core | >=0.7.0 | or | fastify | ^5.8.5 |
const ROW = /^\|\s*([@a-z0-9/._-]+)\s*\|\s*((?:>=|\^|~)[\d.]+)\s*\|/gim;

const failures = [];

for (const doc of WATCHED_DOCS) {
  let text;
  try {
    text = readFileSync(resolve(process.cwd(), doc), "utf8");
  } catch {
    failures.push(`${doc}: missing (watched doc must exist)`);
    continue;
  }
  for (const match of text.matchAll(ROW)) {
    const [, name, documented] = match;
    const declared = peers[name];
    if (declared === undefined) continue; // row for a non-peer (kit example etc.) — not ours to police
    if (declared.trim() !== documented.trim()) {
      failures.push(
        `${doc}: '${name}' documented as '${documented}' but package.json declares '${declared}'`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("[check-docs-drift] contributor docs disagree with package.json:\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nFix the doc rows (or the peer floor) so they match.");
  process.exit(1);
}

console.log(`[check-docs-drift] OK — ${WATCHED_DOCS.join(", ")} agree with package.json peers`);
