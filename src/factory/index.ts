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
 *   auth: { jwt: { secret: process.env.JWT_SECRET } },
 *   cors: { origin: ['https://example.com'] },
 * });
 *
 * // Using createApp directly
 * const app = await createApp({
 *   preset: 'production',
 *   auth: { jwt: { secret: process.env.JWT_SECRET } },
 * });
 */

export { createApp, ArcFactory } from './createApp.js';
export { getPreset, productionPreset, developmentPreset, testingPreset } from './presets.js';
export type { CreateAppOptions, UnderPressureOptions, MultipartOptions, RawBodyOptions } from './types.js';
