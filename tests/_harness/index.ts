/**
 * Arc's DEV test harness — for arc's own suite only.
 *
 * Three homes, three audiences, no overlap:
 *
 *   `src/testing/`            SHIPPED. Hosts testing their arc apps.
 *   `tests/_harness/` (here)  Arc's own suite. May use `src/` internals.
 *   `@classytic/arc-testkit`  SHIPPED. Ecosystem packages testing modules.
 *
 * Import one thing:  `import { arcApp, aResource, PERMS } from "../_harness/index.js";`
 *
 * There is deliberately no DATABASE helper here. A run-wide pooled mongod was
 * built and MEASURED against the status quo: it was SLOWER at both lane scale
 * (10s vs 6s on tests/adapters/) and suite scale (75s vs 71s median), because
 * ~155 independent in-memory servers parallelize better than one contended
 * one, and mongodb-memory-server boots cheaply once its binary is cached.
 * Files keep starting their own — that is the faster design, not debt.
 */

export { type ArcApp, arcApp, arcAppRefuses } from "./app.js";
export { anAdapter, aResource, aScope, PERMS } from "./fixtures.js";
export {
  type ActionCall,
  ANONYMOUS,
  forEachSurface,
  type Identity,
  type MaybeIdentity,
  type Op,
  type Surface,
  type SurfaceCall,
  type SurfaceResult,
} from "./surfaces.js";
