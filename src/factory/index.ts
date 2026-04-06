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

export { ArcFactory, createApp } from "./createApp.js";
export type { FetchHandlerOptions } from "./edge.js";
export { toFetchHandler } from "./edge.js";
export { type LoadResourcesOptions, loadResources, type ResourceLike } from "./loadResources.js";
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
