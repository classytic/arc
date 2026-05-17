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

// Production-shaped sibling of `loadResources`. Directory scanning fails
// for some hosts under tsx / vitest (Node `#path` subpath imports,
// transitive `.js→.ts` resolution, top-level engine init); the glob form
// sidesteps those paths. Re-exported here so compliance smokes find the
// helper next to `loadResources` in autocomplete + docs — the canonical
// source still lives in `src/testing/preloadResources.ts` and is also
// available from `@classytic/arc/testing`.
export {
  preloadResources,
  preloadResourcesAsync,
} from "../testing/preloadResources.js";
export { ArcFactory, createApp } from "./createApp.js";
export type { FetchHandlerOptions } from "./edge.js";
export { toFetchHandler } from "./edge.js";
export {
  type LoadResourcesOptions,
  loadResources,
  type ResourceLike,
  type ResourceModule,
} from "./loadResources.js";
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
} from "./types.js";
