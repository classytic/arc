/**
 * Hook System
 *
 * Lifecycle hooks for resource operations.
 * Allows intercepting and modifying data at various points.
 */

import type { AnyRecord, RequestContext, UserBase } from "../types/index.js";

// ============================================================================
// Hook Types
// ============================================================================

export type HookPhase = "before" | "around" | "after";
export type HookOperation = "create" | "update" | "delete" | "restore" | "read" | "list";

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
  ctx: HookContext<T>,
) => void | Promise<void> | T | Promise<T>;

/**
 * Around hook handler — wraps the core operation.
 * Call `next()` to proceed to the next around hook or the actual operation.
 */
export type AroundHookHandler<T = AnyRecord> = (
  ctx: HookContext<T>,
  next: () => Promise<T | undefined>,
) => T | undefined | Promise<T | undefined>;

export interface HookRegistration {
  /** Hook name for dependency resolution and debugging */
  name?: string;
  resource: string;
  operation: HookOperation;
  phase: HookPhase;
  handler: HookHandler;
  priority: number;
  /** Names of hooks that must execute before this one */
  dependsOn?: string[];
}

// ============================================================================
// Hook System Types
// ============================================================================

export interface HookSystemOptions {
  /** Custom logger for error/warning reporting. Defaults to console */
  logger?: {
    error: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
  };
}

// ============================================================================
// Hook System Class
// ============================================================================

export class HookSystem {
  private hooks: Map<string, HookRegistration[]>;
  private logger: { error: (message: string, ...args: unknown[]) => void };
  private warn: (message: string, ...args: unknown[]) => void;

  constructor(options?: HookSystemOptions) {
    this.hooks = new Map();
    // No-op by default — the caller (arcCorePlugin) injects fastify.log.
    // Silent default prevents unstructured stderr in consumer apps.
    const noop = () => {};
    this.logger = options?.logger ?? { error: noop };
    this.warn = options?.logger?.warn ?? noop;
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
    resourceOrOptions:
      | string
      | {
          name?: string;
          resource: string;
          operation: HookOperation;
          phase: HookPhase;
          handler: HookHandler<T>;
          priority?: number;
          dependsOn?: string[];
        },
    operation?: HookOperation,
    phase?: HookPhase,
    handler?: HookHandler<T>,
    priority = 10,
  ): () => void {
    // Handle object parameter
    let hookName: string | undefined;
    let resource: string;
    let finalOperation: HookOperation;
    let finalPhase: HookPhase;
    let finalHandler: HookHandler<T>;
    let finalPriority: number;
    let dependsOn: string[] | undefined;

    if (typeof resourceOrOptions === "object") {
      // Object syntax: register({ name, resource, operation, phase, handler, priority, dependsOn })
      hookName = resourceOrOptions.name;
      resource = resourceOrOptions.resource;
      finalOperation = resourceOrOptions.operation;
      finalPhase = resourceOrOptions.phase;
      finalHandler = resourceOrOptions.handler;
      finalPriority = resourceOrOptions.priority ?? 10;
      dependsOn = resourceOrOptions.dependsOn;
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
      name: hookName,
      resource,
      operation: finalOperation,
      phase: finalPhase,
      handler: finalHandler as HookHandler,
      priority: finalPriority,
      dependsOn,
    };

    const hooks = this.hooks.get(key)!;
    hooks.push(registration);

    // Sort by priority (lower runs first) — topological sort done at execution time
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
    priority = 10,
  ): () => void {
    return this.register(resource, operation, "before", handler, priority);
  }

  /**
   * Register after hook
   */
  after<T = AnyRecord>(
    resource: string,
    operation: HookOperation,
    handler: HookHandler<T>,
    priority = 10,
  ): () => void {
    return this.register(resource, operation, "after", handler, priority);
  }

  /**
   * Register around hook — wraps the core operation.
   * Call `next()` inside the handler to proceed.
   */
  around<T = AnyRecord>(
    resource: string,
    operation: HookOperation,
    handler: AroundHookHandler<T>,
    priority = 10,
  ): () => void {
    return this.register(resource, operation, "around", handler as HookHandler, priority);
  }

  /**
   * Execute around hooks as a nested middleware chain.
   * Each around hook receives `next()` to call the next hook or the core operation.
   */
  async executeAround<T = AnyRecord>(
    resource: string,
    operation: HookOperation,
    data: T,
    execute: () => Promise<T | undefined>,
    options?: {
      user?: UserBase;
      context?: RequestContext;
      meta?: AnyRecord;
    },
  ): Promise<T | undefined> {
    const key = this.getKey(resource, operation, "around");
    const hooks = [...(this.hooks.get(key) ?? [])];

    // Also check wildcard
    const wildcardKey = this.getKey("*", operation, "around");
    const wildcardHooks = this.hooks.get(wildcardKey) ?? [];
    const allHooks = [...wildcardHooks, ...hooks];
    allHooks.sort((a, b) => a.priority - b.priority);

    if (allHooks.length === 0) {
      return execute();
    }

    // Build nested next() chain
    let index = 0;
    const next = async (): Promise<T | undefined> => {
      if (index < allHooks.length) {
        const hook = allHooks[index++]!;
        const ctx: HookContext<T> = {
          resource,
          operation,
          phase: "around",
          data,
          user: options?.user,
          context: options?.context,
          meta: options?.meta,
        };
        return (hook.handler as unknown as AroundHookHandler<T>)(ctx, next);
      }
      return execute();
    };

    return next();
  }

  /**
   * Execute hooks for a given context
   */
  async execute<T = AnyRecord>(ctx: HookContext<T>): Promise<T | undefined> {
    const key = this.getKey(ctx.resource, ctx.operation, ctx.phase);
    const hooks = this.hooks.get(key) ?? [];

    // Also check for wildcard hooks
    const wildcardKey = this.getKey("*", ctx.operation, ctx.phase);
    const wildcardHooks = this.hooks.get(wildcardKey) ?? [];

    let allHooks = [...wildcardHooks, ...hooks];
    allHooks.sort((a, b) => a.priority - b.priority);

    // Apply topological sort if any hook has dependsOn
    if (allHooks.some((h) => h.dependsOn?.length)) {
      allHooks = this.topologicalSort(allHooks);
    }

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
    },
  ): Promise<T> {
    const result = await this.execute<T>({
      resource,
      operation,
      phase: "before",
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
    },
  ): Promise<void> {
    try {
      await this.execute({
        resource,
        operation,
        phase: "after",
        result,
        user: options?.user,
        context: options?.context,
        meta: options?.meta,
      });
    } catch (error) {
      // Log error but don't fail the request
      this.logger.error(`[HookSystem] Error in after hook for ${resource}:${operation}:`, error);
    }
  }

  /**
   * Topological sort with Kahn's algorithm.
   * Hooks with `dependsOn` are ordered after their dependencies.
   * Within the same dependency level, priority ordering is preserved.
   * Hooks without names or dependencies pass through in their original order.
   */
  private topologicalSort(hooks: HookRegistration[]): HookRegistration[] {
    // Build adjacency list and in-degree map
    const byName = new Map<string, HookRegistration>();
    const inDegree = new Map<HookRegistration, number>();
    const dependents = new Map<string, HookRegistration[]>();

    for (const hook of hooks) {
      inDegree.set(hook, 0);
      if (hook.name) {
        byName.set(hook.name, hook);
      }
    }

    for (const hook of hooks) {
      if (hook.dependsOn) {
        let resolvedDeps = 0;
        for (const dep of hook.dependsOn) {
          if (byName.has(dep)) {
            resolvedDeps++;
            if (!dependents.has(dep)) dependents.set(dep, []);
            dependents.get(dep)?.push(hook);
          } else {
            this.warn(
              `[HookSystem] Hook '${hook.name ?? "<unnamed>"}' depends on '${dep}' which is not registered ` +
                "in the same phase/resource. Dependency will be ignored.",
            );
          }
        }
        inDegree.set(hook, resolvedDeps);
      }
    }

    // Kahn's algorithm: start with hooks that have no dependencies
    const queue: HookRegistration[] = [];
    const result: HookRegistration[] = [];

    for (const hook of hooks) {
      if (inDegree.get(hook)! === 0) {
        queue.push(hook);
      }
    }

    // Sort queue by priority within each level
    queue.sort((a, b) => a.priority - b.priority);

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      if (current.name && dependents.has(current.name)) {
        const deps = dependents.get(current.name)!;
        for (const dep of deps) {
          const newDegree = inDegree.get(dep)! - 1;
          inDegree.set(dep, newDegree);
          if (newDegree === 0) {
            // Insert sorted by priority
            const insertIdx = queue.findIndex((q) => q.priority > dep.priority);
            if (insertIdx === -1) {
              queue.push(dep);
            } else {
              queue.splice(insertIdx, 0, dep);
            }
          }
        }
      }
    }

    // Detect cycles: if result doesn't contain all hooks, there's a cycle
    if (result.length < hooks.length) {
      const missing = hooks.filter((h) => !result.includes(h));
      const names = missing.map((h) => h.name ?? "<unnamed>").join(", ");
      this.logger.error(
        `[HookSystem] Circular dependency detected in hooks: ${names}. ` +
          "These hooks will be appended in priority order.",
      );
      // Append cycled hooks in priority order (best effort)
      missing.sort((a, b) => a.priority - b.priority);
      result.push(...missing);
    }

    return result;
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
   * Get hooks matching filter criteria.
   * Useful for debugging and testing specific hook combinations.
   *
   * @example
   * ```typescript
   * // Find all before-create hooks for products (including wildcards)
   * const hooks = hookSystem.getRegistered({
   *   resource: 'product',
   *   operation: 'create',
   *   phase: 'before',
   * });
   * ```
   */
  getRegistered(filter?: {
    resource?: string;
    operation?: HookOperation;
    phase?: HookPhase;
  }): HookRegistration[] {
    let results = this.getAll();
    if (filter?.resource) {
      results = results.filter((h) => h.resource === filter.resource || h.resource === "*");
    }
    if (filter?.operation) {
      results = results.filter((h) => h.operation === filter.operation);
    }
    if (filter?.phase) {
      results = results.filter((h) => h.phase === filter.phase);
    }
    return results;
  }

  /**
   * Get a structured summary of all registered hooks for debugging.
   *
   * @example
   * ```typescript
   * const info = hookSystem.inspect();
   * // { total: 12, resources: { product: [...], '*': [...] }, summary: [...] }
   * ```
   */
  inspect(): {
    total: number;
    resources: Record<string, HookRegistration[]>;
    summary: Array<{
      name?: string;
      key: string;
      priority: number;
      dependsOn?: string[];
    }>;
  } {
    const all = this.getAll();
    const byResource = new Map<string, HookRegistration[]>();
    for (const hook of all) {
      const arr = byResource.get(hook.resource) ?? [];
      arr.push(hook);
      byResource.set(hook.resource, arr);
    }
    return {
      total: all.length,
      resources: Object.fromEntries(byResource),
      summary: all.map((h) => ({
        name: h.name,
        key: `${h.resource}:${h.operation}:${h.phase}`,
        priority: h.priority,
        ...(h.dependsOn?.length ? { dependsOn: h.dependsOn } : {}),
      })),
    };
  }

  /**
   * Check if any hooks exist for a specific resource/operation/phase combination.
   */
  has(resource: string, operation: HookOperation, phase: HookPhase): boolean {
    const key = this.getKey(resource, operation, phase);
    return (this.hooks.get(key)?.length ?? 0) > 0;
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
// Factory Function
// ============================================================================

/**
 * Create a new isolated HookSystem instance
 *
 * Use this for:
 * - Test isolation (parallel test suites)
 * - Multiple app instances with independent hooks
 *
 * @example
 * const hooks = createHookSystem();
 * await app.register(arcCorePlugin, { hookSystem: hooks });
 *
 * @example With custom logger
 * const hooks = createHookSystem({ logger: fastify.log });
 */
export function createHookSystem(options?: HookSystemOptions): HookSystem {
  return new HookSystem(options);
}

// ============================================================================
// defineHook — Declarative hook with name + dependency support
// ============================================================================

export interface DefineHookOptions<T = AnyRecord> {
  /** Unique hook name (required for dependency resolution) */
  name: string;
  /** Target resource */
  resource: string;
  /** CRUD operation */
  operation: HookOperation;
  /** before or after */
  phase: HookPhase;
  /** Hook handler */
  handler: HookHandler<T>;
  /** Priority (lower = earlier, default: 10) */
  priority?: number;
  /** Names of hooks that must execute before this one */
  dependsOn?: string[];
}

/**
 * Define a named hook with optional dependencies.
 * Returns a registration object — call `register(hookSystem)` to activate.
 *
 * @example
 * ```typescript
 * const generateSlug = defineHook({
 *   name: 'generateSlug',
 *   resource: 'product', operation: 'create', phase: 'before',
 *   handler: (ctx) => ({ ...ctx.data, slug: slugify(ctx.data.name) }),
 * });
 *
 * const validateUniqueSlug = defineHook({
 *   name: 'validateUniqueSlug',
 *   resource: 'product', operation: 'create', phase: 'before',
 *   dependsOn: ['generateSlug'],
 *   handler: async (ctx) => { // check uniqueness },
 * });
 *
 * // Register on a hook system
 * generateSlug.register(hooks);
 * validateUniqueSlug.register(hooks);
 * ```
 */
export function defineHook<T = AnyRecord>(
  options: DefineHookOptions<T>,
): DefineHookOptions<T> & { register: (hooks: HookSystem) => () => void } {
  return {
    ...options,
    register(hooks: HookSystem): () => void {
      return hooks.register({
        name: options.name,
        resource: options.resource,
        operation: options.operation,
        phase: options.phase,
        handler: options.handler,
        priority: options.priority,
        dependsOn: options.dependsOn,
      });
    },
  };
}

// ============================================================================
// Convenience Functions (operate on a provided HookSystem instance)
// ============================================================================

/**
 * Create a before-create hook registration for a given hook system
 */
export function beforeCreate<T = AnyRecord>(
  hooks: HookSystem,
  resource: string,
  handler: HookHandler<T>,
  priority = 10,
): () => void {
  return hooks.before(resource, "create", handler, priority);
}

/**
 * Create an after-create hook registration for a given hook system
 */
export function afterCreate<T = AnyRecord>(
  hooks: HookSystem,
  resource: string,
  handler: HookHandler<T>,
  priority = 10,
): () => void {
  return hooks.after(resource, "create", handler, priority);
}

/**
 * Create a before-update hook registration for a given hook system
 */
export function beforeUpdate<T = AnyRecord>(
  hooks: HookSystem,
  resource: string,
  handler: HookHandler<T>,
  priority = 10,
): () => void {
  return hooks.before(resource, "update", handler, priority);
}

/**
 * Create an after-update hook registration for a given hook system
 */
export function afterUpdate<T = AnyRecord>(
  hooks: HookSystem,
  resource: string,
  handler: HookHandler<T>,
  priority = 10,
): () => void {
  return hooks.after(resource, "update", handler, priority);
}

/**
 * Create a before-delete hook registration for a given hook system
 */
export function beforeDelete<T = AnyRecord>(
  hooks: HookSystem,
  resource: string,
  handler: HookHandler<T>,
  priority = 10,
): () => void {
  return hooks.before(resource, "delete", handler, priority);
}

/**
 * Create an after-delete hook registration for a given hook system
 */
export function afterDelete<T = AnyRecord>(
  hooks: HookSystem,
  resource: string,
  handler: HookHandler<T>,
  priority = 10,
): () => void {
  return hooks.after(resource, "delete", handler, priority);
}
