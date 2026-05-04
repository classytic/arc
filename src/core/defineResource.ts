/**
 * Resource Definition — database-agnostic single source of truth.
 *
 * `defineResource()` is the main entry point for arc resources. It
 * runs a fixed seven-phase pipeline that produces a fully-validated
 * `ResourceDefinition`:
 *
 *   1. validate                  — fail-fast structural checks
 *   2. resolveIdField            — auto-derive `idField` from repository
 *   3. applyPresetsAndAutoInject — clone + apply presets + tenant rules
 *   4. resolveController         — reuse user controller or auto-build
 *   5. buildResource             — construct ResourceDefinition + verify
 *   6. wireHooks                 — preset + inline `config.hooks`
 *   7. resolveOpenApiSchemas     — adapter → parser listQuery → user
 *
 * Each phase has its own module under `./defineResource/`. This file
 * is the orchestrator only — it threads `resolvedConfig` between
 * phases and delegates every responsibility. The `ResourceDefinition`
 * class itself lives in `./defineResource/ResourceDefinition.ts`.
 *
 * @example Mongoose
 * ```typescript
 * import { defineResource } from '@classytic/arc';
 * import { createMongooseAdapter } from '@classytic/mongokit/adapter';
 * import { allowPublic, requireRoles } from '@classytic/arc/permissions';
 *
 * export default defineResource({
 *   name: 'product',
 *   adapter: createMongooseAdapter({
 *     model: ProductModel,
 *     repository: productRepository,
 *   }),
 *   presets: ['softDelete', 'slugLookup'],
 *   permissions: {
 *     list: allowPublic(),
 *     get: allowPublic(),
 *     create: requireRoles(['admin']),
 *     update: requireRoles(['admin']),
 *     delete: requireRoles(['admin']),
 *   },
 * });
 * ```
 *
 * @example Prisma
 * ```typescript
 * import { defineResource } from '@classytic/arc';
 * import { createPrismaAdapter } from '@classytic/prismakit/adapter';
 *
 * export default defineResource({
 *   name: 'user',
 *   adapter: createPrismaAdapter({
 *     client: prisma,
 *     modelName: 'user',
 *     repository: userRepository,
 *   }),
 * });
 * ```
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { AnyRecord, ResourceConfig } from "../types/index.js";
import type { InternalResourceConfig } from "./defineResource/config.js";
import { resolveOrAutoCreateController } from "./defineResource/controller.js";
import { wireHooks } from "./defineResource/hooks.js";
import { resolveIdField } from "./defineResource/idField.js";
import { applyPresetsAndAutoInject, computeHasCrudRoutes } from "./defineResource/presets.js";
import {
  type ResolvedResourceConfig,
  ResourceDefinition,
} from "./defineResource/ResourceDefinition.js";
import { resolveOpenApiSchemas } from "./defineResource/schemas.js";
import { validateDefineResourceConfig } from "./defineResource/validate.js";

/**
 * `TDoc` is **unconstrained** at this layer. The previous `TDoc
 * extends AnyRecord` bound leaked out of `BaseController`'s
 * mixin-composition requirement into every host's adapter boundary:
 * Mongoose's `HydratedDocument<T>`, Prisma's generated row types,
 * and any domain interface without an explicit index signature all
 * failed to satisfy `Record<string, unknown>` even though at runtime
 * they ARE string-keyed objects. Hosts were forced to cast at every
 * adapter (`as RepositoryLike<Record<string, unknown>>`) — a type
 * escape with no runtime purpose, since arc's pipeline only reads
 * known envelope fields.
 *
 * The cast moved inside `resolveOrAutoCreateController` where
 * `BaseController<TDoc extends AnyRecord>` actually requires it.
 * One internal boundary cast replaces N host-side casts.
 */
export function defineResource<TDoc = AnyRecord>(
  config: ResourceConfig<TDoc>,
): ResourceDefinition<TDoc> {
  // Phase 1 — validate
  if (!config.skipValidation) validateDefineResourceConfig(config);

  // Phase 2 — auto-derive idField from repository before presets see it
  const repository = config.adapter?.repository;
  const configWithId = resolveIdField(config, repository);

  // Phase 3 — apply presets + auto-inject tenant-field rules
  const resolvedConfig = applyPresetsAndAutoInject<TDoc>(configWithId);
  const hasCrudRoutes = computeHasCrudRoutes(resolvedConfig);

  // Phase 4 — reuse user controller or auto-create BaseController.
  // Internal cast widens TDoc to satisfy BaseController's bound; safe
  // at runtime (every doc is a string-keyed object) and bounded to
  // this one site so hosts never see it.
  const narrowedConfig = resolvedConfig as unknown as InternalResourceConfig<TDoc & AnyRecord>;
  const narrowedAdapter = configWithId.adapter as DataAdapter<TDoc & AnyRecord> | undefined;
  const controller = resolveOrAutoCreateController(
    narrowedConfig,
    narrowedAdapter,
    repository,
    hasCrudRoutes,
  );

  // Phase 5 — build ResourceDefinition + validate controller methods
  const resource = new ResourceDefinition({
    ...resolvedConfig,
    adapter: configWithId.adapter,
    controller,
  } as unknown as ResolvedResourceConfig<TDoc>);

  if (!config.skipValidation && controller) resource._validateControllerMethods();

  // Phase 6 — wire preset hooks + inline config.hooks
  wireHooks(resource, narrowedConfig, configWithId.hooks);

  // Phase 7 — resolve OpenAPI schemas (non-fatal; failure leaves
  // _registryMeta undefined so registry consumers see "no metadata"
  // instead of a half-built object).
  if (!config.skipRegistry) {
    const registryMeta = resolveOpenApiSchemas(narrowedConfig);
    if (registryMeta) resource._registryMeta = registryMeta;
  }

  return resource;
}

// Re-export `ResourceDefinition` so external imports
// (`@classytic/arc/core`, MCP integrations, registry, testing harness,
// host code) continue to resolve. The class itself lives next to its
// phase-module siblings under `./defineResource/`.
export { ResourceDefinition } from "./defineResource/ResourceDefinition.js";
