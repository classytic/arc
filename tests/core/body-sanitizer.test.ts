/**
 * BodySanitizer Tests
 *
 * Tests system field stripping, fieldRules enforcement (systemManaged, readonly),
 * field-level write permissions, elevated scope bypass, and updateSchemaOptions.
 */

import { describe, it, expect } from 'vitest';
import { BodySanitizer } from '../../src/core/BodySanitizer.js';
import type { IRequestContext, ArcInternalMetadata, RouteSchemaOptions } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function createSanitizer(schemaOptions: RouteSchemaOptions = {}) {
  return new BodySanitizer({ schemaOptions });
}

function createReq(overrides: Partial<IRequestContext> = {}): IRequestContext {
  return {
    params: {},
    query: {},
    body: {},
    user: null,
    headers: {},
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('BodySanitizer', () => {
  // --------------------------------------------------------------------------
  // System fields stripping
  // --------------------------------------------------------------------------

  describe('system field stripping', () => {
    it('strips _id from request body', () => {
      const sanitizer = createSanitizer();
      const body = { _id: 'injected-id', name: 'Test' };

      const result = sanitizer.sanitize(body, 'create');

      expect(result._id).toBeUndefined();
      expect(result.name).toBe('Test');
    });

    it('strips __v from request body', () => {
      const sanitizer = createSanitizer();
      const body = { __v: 5, name: 'Test' };

      const result = sanitizer.sanitize(body, 'create');

      expect(result.__v).toBeUndefined();
      expect(result.name).toBe('Test');
    });

    it('strips createdAt from request body', () => {
      const sanitizer = createSanitizer();
      const body = { createdAt: '2024-01-01', name: 'Test' };

      const result = sanitizer.sanitize(body, 'create');

      expect(result.createdAt).toBeUndefined();
    });

    it('strips updatedAt from request body', () => {
      const sanitizer = createSanitizer();
      const body = { updatedAt: '2024-01-01', name: 'Test' };

      const result = sanitizer.sanitize(body, 'create');

      expect(result.updatedAt).toBeUndefined();
    });

    it('strips deletedAt from request body', () => {
      const sanitizer = createSanitizer();
      const body = { deletedAt: '2024-01-01', name: 'Test' };

      const result = sanitizer.sanitize(body, 'create');

      expect(result.deletedAt).toBeUndefined();
    });

    it('strips all system fields at once', () => {
      const sanitizer = createSanitizer();
      const body = {
        _id: 'injected',
        __v: 3,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        deletedAt: null,
        name: 'Product',
        price: 100,
      };

      const result = sanitizer.sanitize(body, 'create');

      expect(result).toEqual({ name: 'Product', price: 100 });
    });

    it('preserves non-system fields', () => {
      const sanitizer = createSanitizer();
      const body = {
        name: 'Product',
        price: 99.99,
        description: 'A test product',
        tags: ['new', 'sale'],
      };

      const result = sanitizer.sanitize(body, 'create');

      expect(result).toEqual(body);
    });
  });

  // --------------------------------------------------------------------------
  // fieldRules: systemManaged and readonly
  // --------------------------------------------------------------------------

  describe('fieldRules enforcement', () => {
    it('strips systemManaged fields', () => {
      const sanitizer = createSanitizer({
        fieldRules: {
          internalScore: { systemManaged: true },
          computedField: { systemManaged: true },
        },
      });
      const body = { name: 'Test', internalScore: 95, computedField: 'computed', price: 50 };

      const result = sanitizer.sanitize(body, 'create');

      expect(result.internalScore).toBeUndefined();
      expect(result.computedField).toBeUndefined();
      expect(result.name).toBe('Test');
      expect(result.price).toBe(50);
    });

    it('strips readonly fields', () => {
      const sanitizer = createSanitizer({
        fieldRules: {
          slug: { readonly: true },
          serial: { readonly: true },
        },
      });
      const body = { name: 'Test', slug: 'injected-slug', serial: 'SN-001', price: 50 };

      const result = sanitizer.sanitize(body, 'update');

      expect(result.slug).toBeUndefined();
      expect(result.serial).toBeUndefined();
      expect(result.name).toBe('Test');
      expect(result.price).toBe(50);
    });

    it('allows fields not marked as systemManaged or readonly', () => {
      const sanitizer = createSanitizer({
        fieldRules: {
          internalScore: { systemManaged: true },
          name: {}, // No restrictions
        },
      });
      const body = { name: 'Test', internalScore: 95 };

      const result = sanitizer.sanitize(body, 'create');

      expect(result.name).toBe('Test');
      expect(result.internalScore).toBeUndefined();
    });

    it('handles empty fieldRules gracefully', () => {
      const sanitizer = createSanitizer({ fieldRules: {} });
      const body = { name: 'Test', price: 50 };

      const result = sanitizer.sanitize(body, 'create');

      expect(result).toEqual({ name: 'Test', price: 50 });
    });
  });

  // --------------------------------------------------------------------------
  // Field-level write permissions
  // --------------------------------------------------------------------------

  describe('field-level write permissions', () => {
    it('strips fields user cannot write (writableBy)', () => {
      const sanitizer = createSanitizer();
      const fieldPerms = {
        salary: { _type: 'writableBy' as const, roles: ['admin', 'hr'] },
      };
      const req = createReq({
        user: { _id: 'user-1', role: ['user'] },
        metadata: {
          arc: { fields: fieldPerms },
          _scope: { kind: 'member' as const, organizationId: 'org-1', orgRoles: ['user'] },
        } as unknown as Record<string, unknown>,
      });

      const body = { name: 'Test', salary: 100000 };
      const result = sanitizer.sanitize(body, 'create', req);

      expect(result.salary).toBeUndefined();
      expect(result.name).toBe('Test');
    });

    it('preserves fields user can write (matching roles)', () => {
      const sanitizer = createSanitizer();
      const fieldPerms = {
        salary: { _type: 'writableBy' as const, roles: ['admin', 'hr'] },
      };
      const req = createReq({
        user: { _id: 'user-1', role: ['admin'] },
        metadata: {
          arc: { fields: fieldPerms },
          _scope: { kind: 'member' as const, organizationId: 'org-1', orgRoles: ['admin'] },
        } as unknown as Record<string, unknown>,
      });

      const body = { name: 'Test', salary: 100000 };
      const result = sanitizer.sanitize(body, 'create', req);

      expect(result.salary).toBe(100000);
      expect(result.name).toBe('Test');
    });

    it('preserves fields user can write via org roles', () => {
      const sanitizer = createSanitizer();
      const fieldPerms = {
        department: { _type: 'writableBy' as const, roles: ['hr', 'admin'] },
      };
      const req = createReq({
        user: { _id: 'user-1', role: ['user'] },
        metadata: {
          arc: { fields: fieldPerms },
          _scope: { kind: 'member' as const, organizationId: 'org-1', orgRoles: ['hr'] },
        } as unknown as Record<string, unknown>,
      });

      const body = { name: 'Test', department: 'Engineering' };
      const result = sanitizer.sanitize(body, 'create', req);

      // Org role 'hr' matches writableBy, so field is preserved
      expect(result.department).toBe('Engineering');
    });

    it('strips hidden fields from write', () => {
      const sanitizer = createSanitizer();
      const fieldPerms = {
        password: { _type: 'hidden' as const },
      };
      const req = createReq({
        user: { _id: 'user-1', role: ['admin'] },
        metadata: {
          arc: { fields: fieldPerms },
          _scope: { kind: 'member' as const, organizationId: 'org-1', orgRoles: ['admin'] },
        } as unknown as Record<string, unknown>,
      });

      const body = { name: 'Test', password: 'secret' };
      const result = sanitizer.sanitize(body, 'create', req);

      expect(result.password).toBeUndefined();
      expect(result.name).toBe('Test');
    });
  });

  // --------------------------------------------------------------------------
  // Elevated scope bypass
  // --------------------------------------------------------------------------

  describe('elevated scope bypass', () => {
    it('skips field-level write permissions for elevated scope', () => {
      const sanitizer = createSanitizer();
      const fieldPerms = {
        salary: { _type: 'writableBy' as const, roles: ['admin', 'hr'] },
        internalNotes: { _type: 'writableBy' as const, roles: ['admin'] },
      };
      const req = createReq({
        user: { _id: 'user-1', role: ['superadmin'] },
        metadata: {
          arc: { fields: fieldPerms },
          _scope: { kind: 'elevated' as const, elevatedBy: 'admin' },
        } as unknown as Record<string, unknown>,
      });

      const body = { name: 'Test', salary: 100000, internalNotes: 'Secret notes' };
      const result = sanitizer.sanitize(body, 'create', req);

      // Elevated scope should preserve all fields regardless of writableBy
      expect(result.salary).toBe(100000);
      expect(result.internalNotes).toBe('Secret notes');
      expect(result.name).toBe('Test');
    });

    it('still strips system fields even for elevated scope', () => {
      const sanitizer = createSanitizer();
      const req = createReq({
        user: { _id: 'user-1', role: ['superadmin'] },
        metadata: {
          _scope: { kind: 'elevated' as const, elevatedBy: 'admin' },
        } as unknown as Record<string, unknown>,
      });

      const body = { _id: 'injected', name: 'Test', createdAt: '2024-01-01' };
      const result = sanitizer.sanitize(body, 'create', req);

      // System fields are always stripped, even for elevated scope
      expect(result._id).toBeUndefined();
      expect(result.createdAt).toBeUndefined();
      expect(result.name).toBe('Test');
    });

    it('still strips systemManaged fields even for elevated scope', () => {
      const sanitizer = createSanitizer({
        fieldRules: {
          internalScore: { systemManaged: true },
        },
      });
      const req = createReq({
        user: { _id: 'user-1', role: ['superadmin'] },
        metadata: {
          _scope: { kind: 'elevated' as const, elevatedBy: 'admin' },
        } as unknown as Record<string, unknown>,
      });

      const body = { name: 'Test', internalScore: 95 };
      const result = sanitizer.sanitize(body, 'create', req);

      // systemManaged is stripped before field permissions are applied
      expect(result.internalScore).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // No req context
  // --------------------------------------------------------------------------

  describe('without request context', () => {
    it('sanitizes body without applying field permissions when no req', () => {
      const sanitizer = createSanitizer();
      const body = { _id: 'injected', name: 'Test', salary: 100000 };

      const result = sanitizer.sanitize(body, 'create');

      expect(result._id).toBeUndefined();
      expect(result.name).toBe('Test');
      expect(result.salary).toBe(100000);
    });

    it('sanitizes body without applying field permissions when no arc.fields', () => {
      const sanitizer = createSanitizer();
      const req = createReq({
        user: { _id: 'user-1', role: ['user'] },
        metadata: {
          _scope: { kind: 'member' as const, organizationId: 'org-1', orgRoles: ['user'] },
        } as unknown as Record<string, unknown>,
      });

      const body = { name: 'Test', salary: 100000 };
      const result = sanitizer.sanitize(body, 'create', req);

      // No field permissions configured, so salary is preserved
      expect(result.salary).toBe(100000);
    });
  });

  // --------------------------------------------------------------------------
  // Does not mutate original body
  // --------------------------------------------------------------------------

  describe('immutability', () => {
    it('returns a new object and does not mutate the original body', () => {
      const sanitizer = createSanitizer();
      const body = { _id: 'injected', name: 'Test', price: 100 };
      const originalBody = { ...body };

      const result = sanitizer.sanitize(body, 'create');

      // Original body should be unchanged
      expect(body).toEqual(originalBody);

      // Result should be a different object
      expect(result).not.toBe(body);
      expect(result._id).toBeUndefined();
    });
  });
});
