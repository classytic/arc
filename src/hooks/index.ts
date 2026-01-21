/**
 * Hooks Module
 *
 * Lifecycle hooks for resource operations.
 *
 * @example
 * import { hookSystem, beforeCreate, afterUpdate } from '@classytic/arc/hooks';
 *
 * // Register hooks
 * beforeCreate('product', async (ctx) => {
 *   // Modify data before create
 *   return { ...ctx.data, slug: generateSlug(ctx.data.name) };
 * });
 *
 * afterUpdate('product', async (ctx) => {
 *   // Log after update
 *   console.log('Product updated:', ctx.result);
 * });
 */

export {
  HookSystem,
  hookSystem,
  createHookSystem,
  beforeCreate,
  afterCreate,
  beforeUpdate,
  afterUpdate,
  beforeDelete,
  afterDelete,
} from './HookSystem.js';

export type {
  HookPhase,
  HookOperation,
  HookContext,
  HookHandler,
  HookRegistration,
  HookSystemOptions,
} from './HookSystem.js';
