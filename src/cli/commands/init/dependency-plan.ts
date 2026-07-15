/**
 * Single source of truth for scaffolded project dependencies.
 *
 * Two layers keep the scaffold from ever contradicting the arc release
 * that ships it:
 *
 *   1. The static table below — tracks published npm latest, bumped on
 *      release. Serves as the offline fallback.
 *   2. A runtime overlay from arc's OWN package.json (version + declared
 *      peer floors). The 2.20.0 review found the static pins had drifted
 *      (`arc ^2.18.5` + `primitives ^0.6.0` while arc 2.20 peers demand
 *      >=0.9.0 → ERESOLVE on the first `arc init` a new user runs).
 *      Deriving from the installed package.json makes that class of
 *      breakage structurally impossible: the scaffold always pins the
 *      arc version actually running and ranges that satisfy its peers.
 *
 * Used by both `packageJsonTemplate` (declares the deps in the generated
 * `package.json` so `npm install` works without a pre-pass) and
 * `installDependencies` (runs the package manager's `install` against
 * the declared ranges). One source — no drift.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DependencyManifest, ProjectConfig } from "./types.js";

export const SCAFFOLD_DEP_VERSIONS = {
  // Core runtime — required for every preset.
  // `@classytic/repo-core` is a REQUIRED arc peer (arc 2.12+ ships
  // pagination, adapter contract, and filter helpers from there).
  // `@classytic/primitives` is REQUIRED for events.
  core: {
    "@classytic/arc": "^2.20.0",
    // 0.x carets never float across minors (^0.9.1 can't resolve 0.11.x),
    // so these MUST track published latest, not just arc's peer floors.
    "@classytic/primitives": "^0.11.0",
    "@classytic/repo-core": "^0.8.0",
    "@fastify/cors": "^11.2.0",
    "@fastify/helmet": "^13.0.2",
    "@fastify/rate-limit": "^10.3.0",
    "@fastify/sensible": "^6.0.4",
    "@fastify/under-pressure": "^9.0.3",
    dotenv: "^17.4.2",
    fastify: "^5.8.5",
    // Typed, fail-fast environment validation in src/config/index.ts.
    // Also arc's own validation peer — one schema dialect across the stack.
    zod: "^4.3.6",
  },
  // Auth presets — picked by `config.auth`
  authJwt: {
    "@fastify/jwt": "^10.1.0",
    bcryptjs: "^3.0.3",
  },
  authBetterAuth: {
    "better-auth": "^1.6.11",
    // mongodb 7 — mongoose 9 ships bson@7, so the top-level mongodb peer
    // must also use bson@7 or BA's mongo-adapter throws
    // `BSONVersionError: bson types must be from bson 7.x.x` on every
    // user/org write.
    mongodb: "^7.2.0",
  },
  authBetterAuthApiKey: {
    "@better-auth/api-key": "^1.6.11",
  },
  // Adapter presets — picked by `config.adapter`. The kit ships its own
  // arc-compatible adapter at `<kit>/adapter` (arc 2.12+); the kit owns
  // the driver peer (mongoose for mongokit, etc.).
  adapterMongokit: {
    // 3.21+ — adapter defaults schemaGenerator to buildCrudSchemasFromModel
    "@classytic/mongokit": "^3.21.0",
    mongoose: "^9.6.2",
  },
  // Dev tooling — common to every project
  devCommon: {
    // Biome = formatter + linter in one, zero-config. `npm run lint`.
    "@biomejs/biome": "^2.4.15",
    "mongodb-memory-server": "^11.1.0",
    "pino-pretty": "^13.1.3",
    vitest: "^4.1.7",
  },
  devTypescript: {
    // @types/node tracks Node.js major — pin to 22 to match arc's >=22 requirement
    "@types/node": "^22.10.0",
    tsx: "^4.22.3",
    // TS 7 = the Go-native compiler (GA 2026-07); type-checking is identical
    // to 6.0 but ~10x faster. Scaffolds only use `tsc` (no compiler-API tools),
    // so hosts get the speedup with zero migration surface.
    typescript: "^7.0.2",
  },
  // Type definitions — paired with their runtime dep
  typesJwt: {
    "@types/bcryptjs": "^3.0.0",
  },
} as const;

interface OwnPackageJson {
  name?: string;
  version?: string;
  peerDependencies?: Record<string, string>;
}

/**
 * Locate arc's own package.json by walking up from the executing file.
 * A path walk (vs `require.resolve('@classytic/arc/package.json')`) works
 * regardless of bundle chunk layout and of package.json not being in the
 * exports map. Returns undefined when not found — callers fall back to
 * the static table.
 */
function readOwnPackageJson(): OwnPackageJson | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 6; depth++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as OwnPackageJson;
        if (parsed.name === "@classytic/arc") return parsed;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unreadable/corrupt package.json — static fallback covers it.
  }
  return undefined;
}

/** First x.y.z triple in a range string, or undefined. */
function parseFloor(range: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function floorLessThan(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/**
 * Overlay live truth from arc's own package.json onto the static pins:
 *   - `@classytic/arc` pins the exact running version (`^<version>`).
 *   - Any scaffolded dep that is also an arc peer gets raised to `^<peer
 *     floor>` when the static pin's floor is BELOW the declared peer floor
 *     (never lowered — static pins may legitimately be ahead of the floor).
 */
// ── Registry-latest overlay (2.22) ─────────────────────────────────────
//
// Best practice for scaffolds: new apps start on the LATEST STABLE of every
// dependency, not on the floors the shipping arc release happened to pin.
// `primeLatestScaffoldVersions()` (called once by `init`, network-parallel,
// hard timeout) fills a cache; the sync resolver overlays it with guards:
//
//   - never a downgrade
//   - never a prerelease (`latest` dist-tag only, `-` rejected belt+braces)
//   - never a MAJOR cross for third-party packages (the scaffold's tested
//     major wins — an untested zod/fastify major must not land silently)
//   - `@classytic/*` floats freely (we own the compat story; this also
//     solves the 0.x-caret-never-floats maintenance burden for our own kits)
//
// Offline / registry failure / test runs → cache stays empty → identical
// pre-2.22 behavior (static table + live-arc overlay).

const latestCache = new Map<string, string>();

/** Test hook — deterministic overlay without network. */
export function __setLatestVersionsForTest(entries: Record<string, string> | null): void {
  latestCache.clear();
  if (entries) for (const [k, v] of Object.entries(entries)) latestCache.set(k, v);
}

function allScaffoldPackageNames(): string[] {
  const names = new Set<string>();
  for (const group of Object.values(SCAFFOLD_DEP_VERSIONS)) {
    for (const name of Object.keys(group)) names.add(name);
  }
  return [...names];
}

export async function primeLatestScaffoldVersions(options?: {
  timeoutMs?: number;
  registry?: string;
}): Promise<{ resolved: number; total: number }> {
  const timeoutMs = options?.timeoutMs ?? 3500;
  const registry = (
    options?.registry ??
    process.env.npm_config_registry ??
    "https://registry.npmjs.org"
  ).replace(/\/$/, "");
  const names = allScaffoldPackageNames();

  const results = await Promise.allSettled(
    names.map(async (name) => {
      const res = await fetch(`${registry}/${name}/latest`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { version?: string };
      if (typeof body.version === "string" && /^\d+\.\d+\.\d+$/.test(body.version)) {
        latestCache.set(name, body.version);
      }
    }),
  );
  return { resolved: latestCache.size, total: results.length };
}

function parseBareVersion(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function applyLatestOverlay(dependencies: Record<string, string>): void {
  if (latestCache.size === 0) return;
  for (const [name, currentRange] of Object.entries(dependencies)) {
    const latest = latestCache.get(name);
    if (!latest || latest.includes("-")) continue;
    const latestV = parseBareVersion(latest);
    const currentFloor = parseFloor(currentRange);
    if (!latestV || !currentFloor) continue;
    if (!floorLessThan(currentFloor, latestV)) continue; // no downgrade / no-op
    const crossesMajor = latestV[0] !== currentFloor[0];
    if (crossesMajor && !name.startsWith("@classytic/")) continue; // tested major wins
    dependencies[name] = `^${latest}`;
  }
}

function overlayLiveArcVersions(dependencies: Record<string, string>): void {
  const own = readOwnPackageJson();
  if (!own) return;

  if (own.version && dependencies["@classytic/arc"]) {
    dependencies["@classytic/arc"] = `^${own.version}`;
  }

  const peers = own.peerDependencies ?? {};
  for (const [name, staticRange] of Object.entries(dependencies)) {
    const peerRange = peers[name];
    if (!peerRange) continue;
    const peerFloor = parseFloor(peerRange);
    const staticFloor = parseFloor(staticRange);
    if (!peerFloor || !staticFloor) continue;
    if (floorLessThan(staticFloor, peerFloor)) {
      dependencies[name] = `^${peerFloor.join(".")}`;
    }
  }
}

/**
 * Resolve the dependency manifest for a scaffold configuration.
 *
 * Returns sorted records (alphabetical by package name) so the generated
 * `package.json` is deterministic — diffs across re-runs stay clean.
 */
export function resolveScaffoldDependencies(config: ProjectConfig): DependencyManifest {
  const dependencies: Record<string, string> = { ...SCAFFOLD_DEP_VERSIONS.core };
  const devDependencies: Record<string, string> = { ...SCAFFOLD_DEP_VERSIONS.devCommon };

  if (config.auth === "better-auth") {
    Object.assign(dependencies, SCAFFOLD_DEP_VERSIONS.authBetterAuth);
    // The generated test suite uses arc's turnkey test auth
    // (`createTestApp({ authMode: 'jwt' })`), which signs test tokens via
    // @fastify/jwt — needed as a DEV dep even when runtime auth is BA.
    devDependencies["@fastify/jwt"] = SCAFFOLD_DEP_VERSIONS.authJwt["@fastify/jwt"];
    if (config.apiKey) {
      Object.assign(dependencies, SCAFFOLD_DEP_VERSIONS.authBetterAuthApiKey);
    }
  } else {
    Object.assign(dependencies, SCAFFOLD_DEP_VERSIONS.authJwt);
    if (config.typescript) {
      Object.assign(devDependencies, SCAFFOLD_DEP_VERSIONS.typesJwt);
    }
  }

  if (config.adapter === "mongokit") {
    Object.assign(dependencies, SCAFFOLD_DEP_VERSIONS.adapterMongokit);
  }

  if (config.typescript) {
    Object.assign(devDependencies, SCAFFOLD_DEP_VERSIONS.devTypescript);
  }

  // Order matters: latest overlay first, peer-floor overlay LAST — so even
  // when the registry was unreachable, peers still lift stale statics.
  applyLatestOverlay(dependencies);
  applyLatestOverlay(devDependencies);
  overlayLiveArcVersions(dependencies);

  return {
    dependencies: sortByKey(dependencies),
    devDependencies: sortByKey(devDependencies),
  };
}

/** Sort a record alphabetically by key — package.json convention. */
function sortByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
