/**
 * Phase 2 — auto-derive `idField` from the repository.
 *
 * MongoKit-style repositories declare their primary key field via
 * `repository.idField`. Picking it up BEFORE preset resolution means
 * the user configures `idField` in ONE place (the repo) and arc
 * threads it through `BaseController`, AJV params schema,
 * `ResourceDefinition.idField`, and preset field wiring consistently.
 *
 * `_id` is treated as the implicit default — auto-derivation only
 * fires for non-default values. Hosts that genuinely want `_id` as
 * their idField don't need any config.
 */

import type { ResourceConfig } from "../../types/index.js";

/**
 * Returns a fresh config with `idField` filled in (when applicable),
 * or the original reference when nothing changes. Never mutates the
 * caller's input.
 */
export function resolveIdField<TDoc>(
  config: ResourceConfig<TDoc>,
  repository: unknown,
): ResourceConfig<TDoc> {
  if (config.idField !== undefined || !repository) return config;
  const repoIdField = (repository as { idField?: unknown }).idField;
  if (typeof repoIdField === "string" && repoIdField !== "_id") {
    return { ...config, idField: repoIdField };
  }
  return config;
}
