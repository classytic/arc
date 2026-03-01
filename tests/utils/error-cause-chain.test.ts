/**
 * ArcError Cause Chain Tests
 *
 * Validates constructor behaviour with/without cause, nested cause chains,
 * and toJSON() serialization of the full error envelope.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ArcError, NotFoundError } from '../../src/utils/errors.js';

// ============================================================================
// Cleanup
// ============================================================================

afterEach(() => {
  // No shared mutable state; hook present for pattern consistency.
});

// ============================================================================
// Constructor – cause handling
// ============================================================================

describe('ArcError cause chain', () => {
  it('should set cause via native Error when provided', () => {
    const root = new Error('root');
    const err = new ArcError('wrapper', { cause: root });

    expect(err.cause).toBe(root);
    expect(err.message).toBe('wrapper');
  });

  it('should work without a cause', () => {
    const err = new ArcError('standalone');

    expect(err.cause).toBeUndefined();
    expect(err.message).toBe('standalone');
    expect(err.code).toBe('ARC_ERROR');
    expect(err.statusCode).toBe(500);
  });

  it('should support a nested ArcError as cause', () => {
    const inner = new ArcError('inner', { code: 'INNER' });
    const outer = new ArcError('outer', { cause: inner });

    expect(outer.cause).toBe(inner);
    expect((outer.cause as ArcError).code).toBe('INNER');
  });
});

// ============================================================================
// toJSON() – cause serialization
// ============================================================================

describe('ArcError toJSON()', () => {
  it('should serialize a plain Error cause as { message, name }', () => {
    const root = new Error('root cause');
    const err = new ArcError('top', { cause: root });
    const json = err.toJSON();

    expect(json.cause).toEqual({ message: 'root cause', name: 'Error' });
  });

  it('should recursively serialize nested ArcError causes', () => {
    const level2 = new ArcError('level-2', { code: 'L2', statusCode: 400 });
    const level1 = new ArcError('level-1', { code: 'L1', cause: level2 });
    const top = new ArcError('top', { cause: level1 });

    const json = top.toJSON();

    // First level cause should be a full ArcError JSON
    const causeL1 = json.cause as Record<string, unknown>;
    expect(causeL1.error).toBe('level-1');
    expect(causeL1.code).toBe('L1');

    // Second level cause (nested inside first)
    const causeL2 = causeL1.cause as Record<string, unknown>;
    expect(causeL2.error).toBe('level-2');
    expect(causeL2.code).toBe('L2');
  });

  it('should omit cause when not present', () => {
    const err = new ArcError('no cause');
    const json = err.toJSON();

    expect(json).not.toHaveProperty('cause');
  });

  it('should include requestId when present', () => {
    const err = new ArcError('with request id', { requestId: 'req-abc-123' });
    const json = err.toJSON();

    expect(json.requestId).toBe('req-abc-123');
  });

  it('should include details when present', () => {
    const err = new ArcError('with details', {
      details: { field: 'email', reason: 'invalid' },
    });
    const json = err.toJSON();

    expect(json.details).toEqual({ field: 'email', reason: 'invalid' });
  });

  it('should include timestamp in ISO format', () => {
    const before = new Date().toISOString();
    const err = new ArcError('timed');
    const after = new Date().toISOString();
    const json = err.toJSON();

    expect(json.timestamp).toBeDefined();
    // Timestamp should be between before and after
    expect(json.timestamp! >= before).toBe(true);
    expect(json.timestamp! <= after).toBe(true);
  });

  it('should include requestId, details, and timestamp together', () => {
    const err = new ArcError('full envelope', {
      requestId: 'req-999',
      details: { retryAfter: 30 },
    });
    const json = err.toJSON();

    expect(json).toMatchObject({
      success: false,
      error: 'full envelope',
      code: 'ARC_ERROR',
      requestId: 'req-999',
      details: { retryAfter: 30 },
    });
    expect(json.timestamp).toBeDefined();
  });
});

// ============================================================================
// NotFoundError – cause chain via subclass
// ============================================================================

describe('NotFoundError cause chain', () => {
  it('should be an instance of ArcError', () => {
    const err = new NotFoundError('product', '123');

    expect(err).toBeInstanceOf(ArcError);
    expect(err.name).toBe('NotFoundError');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusCode).toBe(404);
  });

  it('should serialize correctly via toJSON()', () => {
    const err = new NotFoundError('product', 'abc');
    const json = err.toJSON();

    expect(json.error).toBe("product with identifier 'abc' not found");
    expect(json.code).toBe('NOT_FOUND');
    expect(json.details).toEqual({ resource: 'product', identifier: 'abc' });
  });
});
