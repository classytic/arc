/**
 * Arc CLI - Programmatic API
 *
 * These are CLI utilities for project scaffolding and environment validation.
 * They are NOT runtime framework modules and should NOT be imported in
 * application code. They exist here for scriptable automation only.
 *
 * Primary interface: `arc doctor` / `npx @classytic/arc doctor`
 * Secondary interface: `import { doctor } from '@classytic/arc/cli'`
 *
 * @example
 * // In a setup script or test harness (not application code):
 * import { doctor } from '@classytic/arc/cli';
 * await doctor();
 *
 * import { generate } from '@classytic/arc/cli';
 * await generate('resource', ['product']);
 */

export { describe } from "./commands/describe.js";
export { exportDocs } from "./commands/docs.js";
export { doctor } from "./commands/doctor.js";
export { generate } from "./commands/generate.js";
export { init } from "./commands/init.js";
export { introspect } from "./commands/introspect.js";
