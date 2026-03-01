import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookSystem } from '../../src/hooks/HookSystem.js';

describe('HookSystem introspection', () => {
  let hooks: HookSystem;

  afterEach(() => {
    hooks.clear();
  });

  // ==========================================================================
  // getRegistered()
  // ==========================================================================

  describe('getRegistered()', () => {
    it('returns all hooks when no filter is provided', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());
      hooks.after('order', 'update', vi.fn());
      hooks.before('user', 'delete', vi.fn());

      const result = hooks.getRegistered();

      expect(result).toHaveLength(3);
    });

    it('filters by resource and includes wildcard * matches', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());
      hooks.after('product', 'update', vi.fn());
      hooks.before('order', 'create', vi.fn());
      hooks.after('*', 'create', vi.fn()); // wildcard

      const result = hooks.getRegistered({ resource: 'product' });

      // Should include the 2 product hooks + the wildcard hook
      expect(result).toHaveLength(3);
      expect(result.some((h) => h.resource === '*')).toBe(true);
      expect(result.every((h) => h.resource === 'product' || h.resource === '*')).toBe(true);
    });

    it('filters by operation', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());
      hooks.after('product', 'update', vi.fn());
      hooks.before('order', 'create', vi.fn());

      const result = hooks.getRegistered({ operation: 'create' });

      expect(result).toHaveLength(2);
      expect(result.every((h) => h.operation === 'create')).toBe(true);
    });

    it('filters by phase', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());
      hooks.after('product', 'update', vi.fn());
      hooks.before('order', 'create', vi.fn());
      hooks.after('order', 'delete', vi.fn());

      const result = hooks.getRegistered({ phase: 'after' });

      expect(result).toHaveLength(2);
      expect(result.every((h) => h.phase === 'after')).toBe(true);
    });

    it('applies combined filters', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());
      hooks.after('product', 'create', vi.fn());
      hooks.before('product', 'update', vi.fn());
      hooks.before('order', 'create', vi.fn());

      const result = hooks.getRegistered({
        resource: 'product',
        operation: 'create',
        phase: 'before',
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.resource).toBe('product');
      expect(result[0]!.operation).toBe('create');
      expect(result[0]!.phase).toBe('before');
    });

    it('returns empty array when no hooks match', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());

      const result = hooks.getRegistered({ resource: 'nonexistent' });

      expect(result).toHaveLength(0);
    });
  });

  // ==========================================================================
  // inspect()
  // ==========================================================================

  describe('inspect()', () => {
    it('returns the total count of registered hooks', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());
      hooks.after('product', 'update', vi.fn());
      hooks.before('order', 'create', vi.fn());

      const info = hooks.inspect();

      expect(info.total).toBe(3);
    });

    it('groups hooks by resource in the resources object', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());
      hooks.after('product', 'update', vi.fn());
      hooks.before('order', 'create', vi.fn());

      const info = hooks.inspect();

      expect(Object.keys(info.resources)).toEqual(
        expect.arrayContaining(['product', 'order']),
      );
      expect(info.resources['product']).toHaveLength(2);
      expect(info.resources['order']).toHaveLength(1);
    });

    it('summary entries have name, key (resource:operation:phase), and priority', () => {
      hooks = new HookSystem();
      hooks.register({
        name: 'addSlug',
        resource: 'product',
        operation: 'create',
        phase: 'before',
        handler: vi.fn(),
        priority: 5,
      });

      const info = hooks.inspect();

      expect(info.summary).toHaveLength(1);
      expect(info.summary[0]).toMatchObject({
        name: 'addSlug',
        key: 'product:create:before',
        priority: 5,
      });
    });

    it('returns empty state when no hooks are registered', () => {
      hooks = new HookSystem();

      const info = hooks.inspect();

      expect(info).toEqual({
        total: 0,
        resources: {},
        summary: [],
      });
    });
  });

  // ==========================================================================
  // has()
  // ==========================================================================

  describe('has()', () => {
    it('returns true when a hook exists for the given key', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());

      expect(hooks.has('product', 'create', 'before')).toBe(true);
    });

    it('returns false when no hooks are registered', () => {
      hooks = new HookSystem();

      expect(hooks.has('product', 'create', 'before')).toBe(false);
    });

    it('returns false after unregistering the hook', () => {
      hooks = new HookSystem();
      const unregister = hooks.before('product', 'create', vi.fn());

      expect(hooks.has('product', 'create', 'before')).toBe(true);

      unregister();

      expect(hooks.has('product', 'create', 'before')).toBe(false);
    });

    it('returns false after clear()', () => {
      hooks = new HookSystem();
      hooks.before('product', 'create', vi.fn());
      hooks.after('order', 'update', vi.fn());

      expect(hooks.has('product', 'create', 'before')).toBe(true);

      hooks.clear();

      expect(hooks.has('product', 'create', 'before')).toBe(false);
      expect(hooks.has('order', 'update', 'after')).toBe(false);
    });

    it('does NOT match wildcard hooks (checks exact key only)', () => {
      hooks = new HookSystem();
      // Register a wildcard hook that would match 'product' via getRegistered
      hooks.after('*', 'create', vi.fn());

      // has() checks the exact key — '*:create:after' exists, but 'product:create:after' does not
      expect(hooks.has('*', 'create', 'after')).toBe(true);
      expect(hooks.has('product', 'create', 'after')).toBe(false);
    });
  });
});
