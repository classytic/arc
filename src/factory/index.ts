/**
 * Arc Factory Module
 *
 * Production-ready application factory with sensible defaults.
 * Security plugins are opt-out instead of opt-in.
 *
 * @example
 * import { createApp, ArcFactory } from '@classytic/arc/factory';
 * import mongoose from 'mongoose';
 *
 * await mongoose.connect(process.env.MONGO_URI);
 *
 * // Using factory helper
 * const app = await ArcFactory.production({
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
 *   cors: { origin: ['https://example.com'] },
 * });
 *
 * // Using createApp directly
 * const app = await createApp({
 *   preset: 'production',
 *   auth: { type: 'jwt', jwt: { secret: process.env.JWT_SECRET } },
 * });
 */

// Activate `FastifyInstance.arc?` augmentation for /factory consumers —
// `createApp` returns an instance with `arc` populated; the type should
// reflect that without forcing hosts to also import from /plugins.
import "../types/fastify-augmentation.js";

/**
 * The redact paths arc layers into Fastify's pino when a host supplies none.
 *
 * Re-exported because hosts MUST be able to read it. `resolveLoggerConfig` treats a
 * host-supplied `redact` as authoritative and steps aside entirely — so the moment a
 * host sets its own, this list stops applying and the host's becomes the whole
 * policy. A host is therefore expected to SUPERSET it, and until now could not:
 * `DEFAULT_LOGGER_REDACT_PATHS` was declared `export const` in createApp.ts but
 * reached no public entry point, so the only ways to check were to hand-copy it
 * (a second list, which drifts) or to regex arc's content-hashed bundle (which
 * silently mis-parses — it picks up `MEMORY_STORE_NAMES` and splits on the bundle's
 * escaped quotes).
 *
 * be-prod's list had in fact drifted: it omitted `*.passwordHash`, so the same hash
 * was censored through `fastify.log` and printed through the host's own logger.
 * Nothing threw. Exporting the value is what lets a consumer's guard assert the
 * superset against the REAL baseline instead of a copy of it.
 */
export { ArcFactory, createApp, DEFAULT_LOGGER_REDACT_PATHS } from "./createApp.js";
export type {
  ArcWorker,
  CreateWorkerOptions,
  WorkerHealthOptions,
} from "./createWorker.js";
export { createWorker } from "./createWorker.js";
export type { FetchHandlerOptions } from "./edge.js";
export { toFetchHandler } from "./edge.js";
export {
  type LoadResourcesOptions,
  loadResources,
  type ResourceLike,
  type ResourceModule,
} from "./loadResources.js";
export {
  type ArcModule,
  type ArcModuleInput,
  type ArcModuleRegistry,
  collectModuleHealthChecks,
  collectModuleScheduledJobs,
  collectModuleWorkflows,
  defineModule,
  describeResolvedModule,
  type EventHandlerDefinition,
  extendModule,
  getModuleExports,
  getModuleState,
  getOptionalModuleExports,
  hasModule,
  hasModuleExports,
  lazyModuleExports,
  lazyRequiredModuleExports,
  type ModuleContribution,
  type ModuleDisposer,
  type ModuleExtension,
  type ModuleSetupContext,
  type ModuleState,
  orderModules,
  type ResolvedModuleDescriptor,
  type ResolvedModuleLifecycle,
  type ResolvedResourceDescriptor,
  resolveContribution,
  resolveModule,
  subscribeModuleEventHandlers,
} from "./module/index.js";
// Production-shaped sibling of `loadResources`. Directory scanning fails
// for some hosts under tsx / vitest (Node `#path` subpath imports,
// transitive `.js→.ts` resolution, top-level engine init); the glob form
// sidesteps those paths. Re-exported here so compliance smokes find the
// helper next to `loadResources` in autocomplete + docs — the canonical
// The testing subpath also re-exports these helpers for test-fixture DX.
export {
  preloadResources,
  preloadResourcesAsync,
} from "./preloadResources.js";
export {
  developmentPreset,
  edgePreset,
  getPreset,
  productionPreset,
  testingPreset,
} from "./presets.js";
export type {
  AuthOption,
  BetterAuthOption,
  CreateAppOptions,
  CustomAuthenticatorOption,
  CustomPluginAuthOption,
  JwtAuthOption,
  MultipartOptions,
  RawBodyOptions,
  UnderPressureOptions,
} from "./types/index.js";
