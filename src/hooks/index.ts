/**
 * Hooks Module
 *
 * Lifecycle hooks for resource operations.
 * All hooks are instance-scoped — no global singletons.
 *
 * @example
 * import { createHookSystem, beforeCreate, afterUpdate } from '@classytic/arc/hooks';
 *
 * const hooks = createHookSystem();
 *
 * // Register hooks on a specific instance
 * beforeCreate(hooks, 'product', async (ctx) => {
 *   return { ...ctx.data, slug: generateSlug(ctx.data.name) };
 * });
 *
 * afterUpdate(hooks, 'product', async (ctx) => {
 *   console.log('Product updated:', ctx.result);
 * });
 */

export {
  HookSystem,
  createHookSystem,
  defineHook,
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
  DefineHookOptions,
} from './HookSystem.js';
