/**
 * Single source of truth for scaffolded project dependencies.
 *
 * Versions track the published npm latest — bump here when a new release
 * ships. The carets allow minor + patch upgrades without breaking arc's
 * contract, while preventing the silent breakage of `@latest` on a floor
 * bump.
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
    "@classytic/arc": "^2.18.3",
    "@classytic/primitives": "^0.6.0",
    "@classytic/repo-core": "^0.6.0",
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
    "@classytic/mongokit": "^3.16.0",
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
    typescript: "^6.0.3",
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
