/**
 * Arc CLI - Programmatic API
 *
 * Re-exports CLI commands for programmatic usage.
 *
 * @example
 * import { generate, init } from '@classytic/arc/cli';
 *
 * // Generate a resource
 * await generate('resource', ['product']);
 *
 * // Initialize a new project
 * await init({ name: 'my-api', typescript: true });
 */

export { generate } from './commands/generate.js';
export { init } from './commands/init.js';
export { introspect } from './commands/introspect.js';
export { exportDocs } from './commands/docs.js';
