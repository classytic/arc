/**
 * Release gate: the suite must run against at least the versions arc
 * demands of hosts.
 *
 * For every peerDependency that also appears in devDependencies, the
 * devDep's minimum version must be >= the peer floor. Otherwise the
 * entire test suite validates an API surface OLDER than what arc's
 * peers declare — the 2.20.0 review found peers at primitives >=0.9.0 /
 * repo-core >=0.7.0 while devDeps pinned ^0.7.2 / ^0.6.0, meaning the
 * declared floor had never been executed.
 *
 * Also fails when a REQUIRED peer (not in peerDependenciesMeta.optional)
 * is missing from devDependencies entirely — required peers must be
 * exercised by CI.
 *
 * Wired into `prepublishOnly`. Zero deps — plain x.y.z floor compare.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

const peers = pkg.peerDependencies ?? {};
const devDeps = pkg.devDependencies ?? {};
const optionalPeers = new Set(
  Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional)
    .map(([name]) => name),
);

/** First x.y.z triple in a range string, or null. */
function floorOf(range) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lessThan(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

const failures = [];

for (const [name, peerRange] of Object.entries(peers)) {
  const devRange = devDeps[name];
  if (!devRange) {
    if (!optionalPeers.has(name)) {
      failures.push(
        `${name}: required peer (${peerRange}) is not in devDependencies — the suite never exercises it.`,
      );
    }
    continue;
  }
  const peerFloor = floorOf(peerRange);
  const devFloor = floorOf(devRange);
  if (!peerFloor || !devFloor) continue;
  if (lessThan(devFloor, peerFloor)) {
    failures.push(
      `${name}: devDependency ${devRange} is BELOW the declared peer floor ${peerRange}. ` +
        `The suite runs against an older API than hosts are told to install.`,
    );
  }
}

if (failures.length > 0) {
  console.error("[check-peer-skew] FAIL — peer/devDep version skew detected:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nAlign devDependencies to (at least) each peer floor, reinstall, and re-run the suite.",
  );
  process.exit(1);
}

console.log("[check-peer-skew] OK — every peer floor is covered by devDependencies.");
