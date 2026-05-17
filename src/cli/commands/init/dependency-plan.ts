/**
 * Single source of truth for scaffolded project dependencies.
 *
 * Versions are pinned to the floor each subsystem requires — peer-dep
 * minimums on Arc, kit minimums (mongokit ≥ 3.11, repo-core ≥ 0.2,
 * mongoose ≥ 9.4.1), and major-version stable for the rest. The carets
 * allow minor + patch upgrades without breaking arc's contract, while
 * preventing the silent breakage of `@latest` on a kit floor bump.
 *
 * Used by both `packageJsonTemplate` (declares the deps in the generated
 * `package.json` so `npm install` works without a pre-pass) and
 * `installDependencies` (runs the package manager's `install` against
 * the declared ranges). One source — no drift.
 */

import type { DependencyManifest, ProjectConfig } from "./types.js";

export const SCAFFOLD_DEP_VERSIONS = {
  // Core runtime — required for every preset.
  // `@classytic/repo-core` is a REQUIRED arc peer (arc 2.12+ ships
  // pagination, adapter contract, and filter helpers from there).
  // `@classytic/primitives` is REQUIRED for events.
  core: {
    "@classytic/arc": "^2.13.0",
    "@classytic/primitives": "^0.6.0",
    "@classytic/repo-core": "^0.4.2",
    "@fastify/cors": "^11.2.0",
    "@fastify/helmet": "^13.0.2",
    "@fastify/rate-limit": "^10.3.0",
    "@fastify/sensible": "^6.0.4",
    "@fastify/under-pressure": "^9.0.3",
    dotenv: "^17.4.2",
    fastify: "^5.8.5",
  },
  // Auth presets — picked by `config.auth`
  authJwt: {
    "@fastify/jwt": "^10.0.0",
    bcryptjs: "^3.0.0",
  },
  authBetterAuth: {
    "better-auth": "^1.6.9",
    // mongodb 7 — mongoose 9 ships bson@7, so the top-level mongodb peer
    // must also use bson@7 or BA's mongo-adapter throws
    // `BSONVersionError: bson types must be from bson 7.x.x` on every
    // user/org write.
    mongodb: "^7.1.0",
  },
  authBetterAuthApiKey: {
    "@better-auth/api-key": "^1.6.9",
  },
  // Adapter presets — picked by `config.adapter`. The kit ships its own
  // arc-compatible adapter at `<kit>/adapter` (arc 2.12+); the kit owns
  // the driver peer (mongoose for mongokit, etc.).
  adapterMongokit: {
    "@classytic/mongokit": "^3.13.0",
    mongoose: "^9.6.1",
  },
  // Dev tooling — common to every project
  devCommon: {
    "mongodb-memory-server": "^11.1.0",
    "pino-pretty": "^13.0.0",
    vitest: "^4.1.5",
  },
  devTypescript: {
    "@types/node": "^22.10.0",
    tsx: "^4.21.0",
    typescript: "^5.7.2",
  },
  // Type definitions — paired with their runtime dep
  typesJwt: {
    "@types/bcryptjs": "^3.0.0",
  },
} as const;

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

  return {
    dependencies: sortByKey(dependencies),
    devDependencies: sortByKey(devDependencies),
  };
}

/** Sort a record alphabetically by key — package.json convention. */
function sortByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
