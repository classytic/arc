/**
 * Hook System
 *
 * Lifecycle hooks for resource operations.
 * Allows intercepting and modifying data at various points.
 */

import type { AnyRecord, RequestContext, UserBase } from '../types/index.js';

// ============================================================================
// Hook Types
// ============================================================================

export type HookPhase = 'before' | 'after';
export type HookOperation = 'create' | 'update' | 'delete' | 'read' | 'list';

export interface HookContext<T = AnyRecord> {
  resource: string;
  operation: HookOperation;
  phase: HookPhase;
  data?: T;
  result?: T | T[];
  user?: UserBase;
  context?: RequestContext;
  meta?: AnyRecord;
}

export type HookHandler<T = AnyRecord> = (
  ctx: HookContext<T>
) => void | Promise<void> | T | Promise<T>;

export interface HookRegistration {
  resource: string;
  operation: HookOperation;
  phase: HookPhase;
  handler: HookHandler;
  priority: number;
}

// ============================================================================
// Hook System Class
// ============================================================================

export class HookSystem {
  private hooks: Map<string, HookRegistration[]>;

  constructor() {
    this.hooks = new Map();
  }

  /**
   * Generate hook key
   */
  private getKey(resource: string, operation: HookOperation, phase: HookPhase): string {
    return `${resource}:${operation}:${phase}`;
  }

  /**
   * Register a hook
   * Supports both object parameter and positional arguments
   */
  register<T = AnyRecord>(
    resourceOrOptions: string | {
      resource: string;
      operation: HookOperation;
      phase: HookPhase;
      handler: HookHandler<T>;
      priority?: number;
    },
    operation?: HookOperation,
    phase?: HookPhase,
    handler?: HookHandler<T>,
    priority = 10
  ): () => void {
    // Handle object parameter
    let resource: string;
    let finalOperation: HookOperation;
    let finalPhase: HookPhase;
    let finalHandler: HookHandler<T>;
    let finalPriority: number;

    if (typeof resourceOrOptions === 'object') {
      // Object syntax: register({ resource, operation, phase, handler, priority })
      resource = resourceOrOptions.resource;
      finalOperation = resourceOrOptions.operation;
      finalPhase = resourceOrOptions.phase;
      finalHandler = resourceOrOptions.handler;
      finalPriority = resourceOrOptions.priority ?? 10;
    } else {
      // Positional syntax: register(resource, operation, phase, handler, priority)
      resource = resourceOrOptions;
      finalOperation = operation!;
      finalPhase = phase!;
      finalHandler = handler!;
      finalPriority = priority;
    }

    const key = this.getKey(resource, finalOperation, finalPhase);

    if (!this.hooks.has(key)) {
      this.hooks.set(key, []);
    }

    const registration: HookRegistration = {
      resource,
      operation: finalOperation,
      phase: finalPhase,
      handler: finalHandler as HookHandler,
      priority: finalPriority,
    };

    const hooks = this.hooks.get(key)!;
    hooks.push(registration);

    // Sort by priority (lower runs first)
    hooks.sort((a, b) => a.priority - b.priority);

    // Return unregister function
    return () => {
      const idx = hooks.indexOf(registration);
      if (idx !== -1) {
        hooks.splice(idx, 1);
      }
    };
  }

  /**
   * Register before hook
   */
  before<T = AnyRecord>(
    resource: string,
    operation: HookOperation,
    handler: HookHandler<T>,
    priority = 10
  ): () => void {
    return this.register(resource, operation, 'before', handler, priority);
  }

  /**
   * Register after hook
   */
  after<T = AnyRecord>(
    resource: string,
    operation: HookOperation,
    handler: HookHandler<T>,
    priority = 10
  ): () => void {
    return this.register(resource, operation, 'after', handler, priority);
  }

  /**
   * Execute hooks for a given context
   */
  async execute<T = AnyRecord>(ctx: HookContext<T>): Promise<T | undefined> {
    const key = this.getKey(ctx.resource, ctx.operation, ctx.phase);
    const hooks = this.hooks.get(key) ?? [];

    // Also check for wildcard hooks
    const wildcardKey = this.getKey('*', ctx.operation, ctx.phase);
    const wildcardHooks = this.hooks.get(wildcardKey) ?? [];

    const allHooks = [...wildcardHooks, ...hooks];
    allHooks.sort((a, b) => a.priority - b.priority);

    let result: T | undefined = ctx.data as T | undefined;

    for (const hook of allHooks) {
      // Cast context to HookContext<AnyRecord> for handler compatibility
      const handlerContext: HookContext<AnyRecord> = {
        resource: ctx.resource,
        operation: ctx.operation,
        phase: ctx.phase,
        data: result as AnyRecord | undefined,
        result: ctx.result as AnyRecord | AnyRecord[] | undefined,
        user: ctx.user,
        context: ctx.context,
        meta: ctx.meta,
      };
      const hookResult = await hook.handler(handlerContext);
      if (hookResult !== undefined && hookResult !== null) {
        result = hookResult as T;
      }
    }

    return result;
  }

  /**
   * Execute before hooks
   */
  async executeBefore<T = AnyRecord>(
    resource: string,
    operation: HookOperation,
    data: T,
    options?: {
      user?: UserBase;
      context?: RequestContext;
      meta?: AnyRecord;
    }
  ): Promise<T> {
    const result = await this.execute<T>({
      resource,
      operation,
      phase: 'before',
      data,
      user: options?.user,
      context: options?.context,
      meta: options?.meta,
    });

    return result ?? data;
  }

  /**
   * Execute after hooks
   * Errors in after hooks are logged but don't fail the request
   */
  async executeAfter<T = AnyRecord>(
    resource: string,
    operation: HookOperation,
    result: T | T[],
    options?: {
      user?: UserBase;
      context?: RequestContext;
      meta?: AnyRecord;
    }
  ): Promise<void> {
    try {
      await this.execute({
        resource,
        operation,
        phase: 'after',
        result,
        user: options?.user,
        context: options?.context,
        meta: options?.meta,
      });
    } catch (error) {
      // Log error but don't fail the request
      // TODO: Make logger configurable via constructor
      console.error(
        `[HookSystem] Error in after hook for ${resource}:${operation}:`,
        error
      );
    }
  }

  /**
   * Get all registered hooks
   */
  getAll(): HookRegistration[] {
    const all: HookRegistration[] = [];
    for (const hooks of this.hooks.values()) {
      all.push(...hooks);
    }
    return all;
  }

  /**
   * Get hooks for a specific resource
   */
  getForResource(resource: string): HookRegistration[] {
    const all: HookRegistration[] = [];
    for (const [key, hooks] of this.hooks.entries()) {
      if (key.startsWith(`${resource}:`)) {
        all.push(...hooks);
      }
    }
    return all;
  }

  /**
   * Clear all hooks
   */
  clear(): void {
    this.hooks.clear();
  }

  /**
   * Clear hooks for a specific resource
   */
  clearResource(resource: string): void {
    for (const key of this.hooks.keys()) {
      if (key.startsWith(`${resource}:`)) {
        this.hooks.delete(key);
      }
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const hookSystem = new HookSystem();

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Register a before create hook
 */
export function beforeCreate<T = AnyRecord>(
  resource: string,
  handler: HookHandler<T>,
  priority = 10
): () => void {
  return hookSystem.before(resource, 'create', handler, priority);
}

/**
 * Register an after create hook
 */
export function afterCreate<T = AnyRecord>(
  resource: string,
  handler: HookHandler<T>,
  priority = 10
): () => void {
  return hookSystem.after(resource, 'create', handler, priority);
}

/**
 * Register a before update hook
 */
export function beforeUpdate<T = AnyRecord>(
  resource: string,
  handler: HookHandler<T>,
  priority = 10
): () => void {
  return hookSystem.before(resource, 'update', handler, priority);
}

/**
 * Register an after update hook
 */
export function afterUpdate<T = AnyRecord>(
  resource: string,
  handler: HookHandler<T>,
  priority = 10
): () => void {
  return hookSystem.after(resource, 'update', handler, priority);
}

/**
 * Register a before delete hook
 */
export function beforeDelete<T = AnyRecord>(
  resource: string,
  handler: HookHandler<T>,
  priority = 10
): () => void {
  return hookSystem.before(resource, 'delete', handler, priority);
}

/**
 * Register an after delete hook
 */
export function afterDelete<T = AnyRecord>(
  resource: string,
  handler: HookHandler<T>,
  priority = 10
): () => void {
  return hookSystem.after(resource, 'delete', handler, priority);
}

export default hookSystem;
