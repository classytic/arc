/**
 * `arc init` public entry — re-exports from the modular implementation
 * under `./init/`. Kept as a single-file barrel so existing imports
 * (tests, plugin authors, the CLI dispatch table at `src/cli/index.ts`)
 * resolve without churn after the v2.15.5 split.
 */

export type {
  DependencyManifest,
  InitOptions,
  PackageManager,
  ProjectConfig,
} from "./init/index.js";
export { init } from "./init/index.js";
