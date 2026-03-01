/**
 * Event Types Constants and Helpers Tests
 *
 * Validates the CRUD_EVENT_SUFFIXES constant, crudEventType() helper,
 * and ARC_LIFECYCLE_EVENTS frozen object.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  CRUD_EVENT_SUFFIXES,
  crudEventType,
  ARC_LIFECYCLE_EVENTS,
} from '../../src/events/eventTypes.js';

// ============================================================================
// Cleanup
// ============================================================================

afterEach(() => {
  // No mutable state to clean up for these pure-value tests,
  // but the hook is here for consistency with the test harness.
});

// ============================================================================
// CRUD_EVENT_SUFFIXES
// ============================================================================

describe('CRUD_EVENT_SUFFIXES', () => {
  it('should contain created, updated, and deleted', () => {
    expect(CRUD_EVENT_SUFFIXES).toEqual(['created', 'updated', 'deleted']);
  });

  it('should be readonly (frozen tuple)', () => {
    // TypeScript enforces `as const` at compile time.
    // At runtime the array is still a plain array, so verify
    // its contents are correct and the length is exactly 3.
    expect(CRUD_EVENT_SUFFIXES).toHaveLength(3);
    expect(Object.isFrozen(CRUD_EVENT_SUFFIXES)).toBe(true);
  });
});

// ============================================================================
// crudEventType()
// ============================================================================

describe('crudEventType', () => {
  it('should return "product.created" for resource "product" and suffix "created"', () => {
    expect(crudEventType('product', 'created')).toBe('product.created');
  });

  it('should return "order.deleted" for resource "order" and suffix "deleted"', () => {
    expect(crudEventType('order', 'deleted')).toBe('order.deleted');
  });

  it('should return "user.updated" for resource "user" and suffix "updated"', () => {
    expect(crudEventType('user', 'updated')).toBe('user.updated');
  });
});

// ============================================================================
// ARC_LIFECYCLE_EVENTS
// ============================================================================

describe('ARC_LIFECYCLE_EVENTS', () => {
  it('should have RESOURCE_REGISTERED equal to "arc.resource.registered"', () => {
    expect(ARC_LIFECYCLE_EVENTS.RESOURCE_REGISTERED).toBe('arc.resource.registered');
  });

  it('should have READY equal to "arc.ready"', () => {
    expect(ARC_LIFECYCLE_EVENTS.READY).toBe('arc.ready');
  });

  it('should be frozen (Object.freeze)', () => {
    expect(Object.isFrozen(ARC_LIFECYCLE_EVENTS)).toBe(true);
  });

  it('should not allow adding new properties', () => {
    // Attempting to add a property on a frozen object should either
    // silently fail or throw in strict mode.
    expect(() => {
      (ARC_LIFECYCLE_EVENTS as any).NEW_EVENT = 'arc.new';
    }).toThrow();
  });

  it('should not allow modifying existing properties', () => {
    expect(() => {
      (ARC_LIFECYCLE_EVENTS as any).READY = 'arc.not.ready';
    }).toThrow();
  });
});
