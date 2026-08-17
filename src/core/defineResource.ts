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
import type { ActionsMap, AnyRecord, ResourceConfig } from "../types/index.js";
import type { InternalResourceConfig } from "./defineResource/config.js";
import {
  assertTransactionCapability,
  resolveOrAutoCreateController,
} from "./defineResource/controller.js";
import type { ResourceDiagnostic } from "./defineResource/diagnostics.js";
import { wireHooks } from "./defineResource/hooks.js";
import { resolveIdField } from "./defineResource/idField.js";
import { normalizeResourceConfig } from "./defineResource/normalizeConfig.js";
import {
  applyPresetsAndAutoInject,
  collectUngatedCrudDiagnostics,
  computeHasCrudRoutes,
} from "./defineResource/presets.js";
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
/**
 * Narrow overload: when the host passes an `actions: { ... }` literal, the
 * returned `ResourceDefinition.actions` is typed as the exact captured map
 * (not the wide `ActionsMap | undefined`). Without this overload, hosts that
 * wrote `defineResource({ actions: { send: ..., receive: ... } })` saw
 * `resource.actions` typed `ActionsMap | undefined` and got
 * "'resource.actions' is possibly 'undefined'" on every `resource.actions.send`
 * call. TS infers `TActions` from the object literal at the call site —
 * no explicit generic needed.
 */
export function defineResource<TDoc, TActions extends ActionsMap>(
  config: ResourceConfig<TDoc> & { actions: TActions },
): ResourceDefinition<TDoc> & { readonly actions: TActions };
/**
 * Wide overload: no `actions` declared. `ResourceDefinition<TDoc>.actions`
 * stays `ActionsMap | undefined` exactly as in pre-2.17.1 — no
 * back-compat breakage for hosts that never touched actions.
 */
export function defineResource<TDoc = AnyRecord>(
  config: ResourceConfig<TDoc>,
): ResourceDefinition<TDoc>;
export function defineResource<TDoc = AnyRecord>(
  config: ResourceConfig<TDoc>,
): ResourceDefinition<TDoc> {
  // Phase 0 — expand resource-level shorthands BEFORE validation /
  // CRUD-list resolution so every later phase observes the canonical
  // shape. The coordinator runs every expansion in a fixed order
  // (`referenceData` → `customRoutesOnly` → `crud:` allow-list); see
  // `./defineResource/normalizeConfig.ts`. Explicit narrow settings
  // always win over shorthands. Pure transformation — `config` itself
  // stays untouched; the rest of the pipeline reads the normalised copy.
  const normalisedConfig = normalizeResourceConfig(config);

  // Phase 1 — validate. Hard errors throw synchronously; non-fatal
  // diagnostics flow back as an array so they can be flushed through
  // the host's Fastify logger on first mount (see `buildResourcePlugin`).
  // `console.*` is reserved for `src/cli/` — the framework never speaks
  // directly to stdout from `src/`.
  let diagnostics: ResourceDiagnostic[] = [];
  if (!normalisedConfig.skipValidation) {
    diagnostics = validateDefineResourceConfig(normalisedConfig);
  }

  // Phase 2 — auto-derive idField from repository before presets see it.
  // Reads from the post-Phase-0 normalised config so all later phases
  // observe the resolved `disabledRoutes` / `disableDefaultRoutes`.
  const repository = normalisedConfig.adapter?.repository;
  const configWithId = resolveIdField(normalisedConfig, repository);

  // Phase 3 — apply presets + auto-inject tenant-field rules
  const resolvedConfig = applyPresetsAndAutoInject<TDoc>(configWithId);
  const hasCrudRoutes = computeHasCrudRoutes(resolvedConfig);

  // Post-preset diagnostic: CRUD ops that will mount with NO permission
  // gate (public-by-omission). Must read `resolvedConfig` — presets may
  // inject permissions, and flagging those would be a false positive.
  //
  // Strict mode (resource `strictPermissions: true` OR the
  // `ARC_STRICT_PERMISSIONS` env) upgrades an ungated WRITE from a warning to a
  // FATAL error, so unauthenticated writes cannot ship silently. Off by default
  // — existing hosts keep the warn behavior until they opt in.
  if (!normalisedConfig.skipValidation) {
    const strict =
      resolvedConfig.strictPermissions ?? process.env.ARC_STRICT_PERMISSIONS === "true";
    diagnostics = diagnostics.concat(collectUngatedCrudDiagnostics(resolvedConfig, strict));
  }

  // Fatal diagnostics (severity: "error") fail boot at define-time — the same
  // synchronous UX as `validateCustomRoutePermissions`. Aggregate all of them so
  // the host sees every offending resource slot at once.
  const fatal = diagnostics.filter((d) => d.severity === "error");
  if (fatal.length > 0) {
    throw new Error(fatal.map((d) => d.message).join("\n\n"));
  }

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

  if (!normalisedConfig.skipValidation && controller) resource._validateControllerMethods();

  // Phase 6 — wire preset hooks + inline config.hooks
  wireHooks(resource, narrowedConfig, configWithId.hooks);

  // Phase 7 — resolve OpenAPI schemas (non-fatal; failure leaves
  // _registryMeta undefined so registry consumers see "no metadata"
  // instead of a half-built object).
  if (!normalisedConfig.skipRegistry) {
    const registryMeta = resolveOpenApiSchemas(narrowedConfig);
    if (registryMeta) resource._registryMeta = registryMeta;
  }

  // Defer the transaction-CAPABILITY assertion to registration: this
  // function commonly runs at module import, before `beforeBoot()` connects,
  // and an unresolved topology reports `transactions: false` by design.
  if (resolvedConfig.transactional === true) {
    const name = resolvedConfig.name;
    resource._deferredChecks = [() => assertTransactionCapability(repository, name)];
  }

  // Attach boot-time diagnostics. `buildResourcePlugin` flushes them
  // through `fastify.log.warn` on first mount so the host's configured
  // logger handles framework output.
  if (diagnostics.length > 0) resource._diagnostics = diagnostics;

  return resource;
}

// Re-export `ResourceDefinition` so external imports
// (`@classytic/arc/core`, MCP integrations, registry, testing harness,
// host code) continue to resolve. The class itself lives next to its
// phase-module siblings under `./defineResource/`.
export { ResourceDefinition } from "./defineResource/ResourceDefinition.js";
