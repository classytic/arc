/**
 * Preset Conflict Detection Tests
 *
 * Validates that applyPresets() detects route collisions (same method + path
 * from different presets) and throws descriptive errors, while allowing
 * non-conflicting combinations.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { applyPresets } from '../../src/presets/index.js';

// ============================================================================
// Helpers
// ============================================================================

function minimalConfig(name = 'test') {
  return { name, skipValidation: true, skipRegistry: true } as any;
}

function presetWithRoutes(name: string, routes: Array<{ method: string; path: string }>) {
  return {
    name,
    additionalRoutes: routes.map(r => ({
      method: r.method,
      path: r.path,
      handler: async () => ({ success: true }),
      permissions: (() => true) as any,
      wrapHandler: true as const,
    })),
  };
}

// ============================================================================
// Cleanup
// ============================================================================

afterEach(() => {
  // No shared mutable state; hook present for pattern consistency.
});

// ============================================================================
// Conflict Detection
// ============================================================================

describe('applyPresets conflict detection', () => {
  it('should throw when two presets define the same method + path', () => {
    const presetA = presetWithRoutes('presetA', [
      { method: 'GET', path: '/stats' },
    ]);
    const presetB = presetWithRoutes('presetB', [
      { method: 'GET', path: '/stats' },
    ]);

    expect(() =>
      applyPresets(minimalConfig('product'), [presetA, presetB]),
    ).toThrow('preset conflicts');
  });

  it('should not throw when presets define different routes', () => {
    const presetA = presetWithRoutes('presetA', [
      { method: 'GET', path: '/stats' },
    ]);
    const presetB = presetWithRoutes('presetB', [
      { method: 'GET', path: '/export' },
    ]);

    expect(() =>
      applyPresets(minimalConfig('product'), [presetA, presetB]),
    ).not.toThrow();
  });

  it('should not throw when presets share a path but use different methods', () => {
    const presetA = presetWithRoutes('presetA', [
      { method: 'GET', path: '/archive' },
    ]);
    const presetB = presetWithRoutes('presetB', [
      { method: 'POST', path: '/archive' },
    ]);

    expect(() =>
      applyPresets(minimalConfig('product'), [presetA, presetB]),
    ).not.toThrow();
  });

  it('should include resource name and both preset names in the error message', () => {
    const presetA = presetWithRoutes('alpha', [
      { method: 'DELETE', path: '/purge' },
    ]);
    const presetB = presetWithRoutes('beta', [
      { method: 'DELETE', path: '/purge' },
    ]);

    let errorMessage = '';
    try {
      applyPresets(minimalConfig('invoice'), [presetA, presetB]);
    } catch (e: any) {
      errorMessage = e.message;
    }

    expect(errorMessage).toContain('invoice');
    expect(errorMessage).toContain('alpha');
    expect(errorMessage).toContain('beta');
  });

  it('should work fine with a single preset (no conflicts possible)', () => {
    const preset = presetWithRoutes('solo', [
      { method: 'GET', path: '/summary' },
      { method: 'POST', path: '/summarize' },
    ]);

    const result = applyPresets(minimalConfig('order'), [preset]);

    expect(result.name).toBe('order');
    expect((result as any).additionalRoutes).toHaveLength(2);
  });

  it('should work fine with an empty presets array', () => {
    const result = applyPresets(minimalConfig('widget'), []);

    expect(result.name).toBe('widget');
  });
});
