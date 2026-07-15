/**
 * Types for createApp factory — barrel preserving the original
 * `factory/types` surface exactly.
 *
 * ## File map
 * - `./security.ts`       — `RateLimitPlanConfig` + inlined CORS/Helmet/rate-limit shapes
 * - `./auth.ts`           — `AuthOption` discriminated union + its members
 * - `./plugin-options.ts` — `UnderPressureOptions`, `MultipartOptions`, `RawBodyOptions`
 * - `./app-options.ts`    — `CreateAppOptions` (the big one)
 */

export type { CreateAppOptions } from "./app-options.js";
export type {
  AuthOption,
  BetterAuthOption,
  CustomAuthenticatorOption,
  CustomPluginAuthOption,
  JwtAuthOption,
} from "./auth.js";
export type { MultipartOptions, RawBodyOptions, UnderPressureOptions } from "./plugin-options.js";
export type { RateLimitPlanConfig } from "./security.js";
