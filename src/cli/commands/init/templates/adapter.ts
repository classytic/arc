/**
 * Adapter-factory templates: the `src/shared/adapter.ts` file.
 *
 * Two variants — `createAdapterTemplate` for the mongokit path,
 * `customAdapterTemplate` for the bring-your-own-repository path. The
 * orchestrator picks one based on `config.adapter`.
 */

import type { ProjectConfig } from "../types.js";

export function createAdapterTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * MongoKit Adapter Factory
 *
 * Creates Arc adapters using MongoKit repositories.
 * The repository handles query parsing via MongoKit's built-in QueryParser.
 */

import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';
${ts ? "import type { DataAdapter } from '@classytic/repo-core/adapter';\nimport type { Model } from 'mongoose';\nimport type { Repository } from '@classytic/mongokit';" : ""}

/**
 * Create a MongoKit-powered adapter for a resource.
 *
 * Note: Query parsing is handled by MongoKit's Repository class.
 * \`buildCrudSchemasFromModel\` is the canonical OpenAPI schema generator
 * for arc + Mongoose (arc 2.12+ no longer ships a built-in fallback —
 * passing it explicitly is required for OpenAPI auto-generation).
 */
export function createAdapter${ts ? "<TDoc = unknown>" : ""}(
  model${ts ? ": Model<TDoc>" : ""},
  repository${ts ? ": Repository<TDoc>" : ""}
)${ts ? ": DataAdapter<TDoc>" : ""} {
  // Explicit return type keeps the declaration portable — under pnpm's
  // non-hoisted layout the inferred type references mongokit's internal
  // paths and tsc fails with TS2742/TS2883.
  return createMongooseAdapter({
    model,
    repository,
    schemaGenerator: buildCrudSchemasFromModel,
  });
}
`;
}

export function customAdapterTemplate(config: ProjectConfig): string {
  const ts = config.typescript;

  return `/**
 * Custom Adapter Factory
 *
 * Use this for the bring-your-own-repository path — any object that
 * satisfies the \`RepositoryLike\` contract from
 * \`@classytic/repo-core/adapter\` plugs in here. Each classytic kit
 * also ships its own \`/adapter\` subpath; if one of those fits, import
 * its factory directly instead.
 */

${ts ? "import type { DataAdapter, RepositoryLike } from '@classytic/repo-core/adapter';" : ""}

/**
 * Create a custom adapter for a resource.
 *
 * Pass any object satisfying \`RepositoryLike<TDoc>\` (a 5-method floor:
 * \`getAll\` / \`getById\` / \`create\` / \`update\` / \`delete\`, plus any
 * optional \`StandardRepo\` methods you implement).
 */
export function createAdapter${ts ? "<TDoc = unknown>" : ""}(
  _source${ts ? ": unknown" : ""},
  repository${ts ? ": RepositoryLike<TDoc>" : ""}
)${ts ? ": DataAdapter<TDoc>" : ""} {
  return {
    type: 'custom',
    name: 'custom-repository',
    repository,
  };
}
`;
}
