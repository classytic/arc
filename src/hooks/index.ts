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

export type {
  DefineHookOptions,
  HookContext,
  HookHandler,
  HookOperation,
  HookPhase,
  HookRegistration,
  HookSystemOptions,
} from "./HookSystem.js";
export {
  afterCreate,
  afterDelete,
  afterUpdate,
  beforeCreate,
  beforeDelete,
  beforeUpdate,
  createHookSystem,
  defineHook,
  HookSystem,
} from "./HookSystem.js";
