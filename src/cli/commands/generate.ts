/**
 * `arc generate` public entry — re-exports from the modular implementation
 * under `./generate/`. Kept as a thin barrel so existing imports
 * (`src/cli/index.ts`, the bin's lazy dynamic import, tests) resolve
 * without churn after the v2.16.0 split.
 */

export { generate } from "./generate/index.js";
export type { ArcProjectConfig } from "./generate/types.js";
