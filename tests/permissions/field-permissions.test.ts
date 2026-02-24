/**
 * Field-Level Permissions Tests
 *
 * Tests the field permission system:
 * - hidden() — always stripped from reads and writes
 * - visibleTo(roles) — only visible to specified roles
 * - writableBy(roles) — only writable by specified roles
 * - redactFor(roles) — redacted value for specified roles
 * - applyFieldReadPermissions
 * - applyFieldWritePermissions
 */

import { describe, it, expect } from 'vitest';
import {
  fields,
  applyFieldReadPermissions,
  applyFieldWritePermissions,
  type FieldPermissionMap,
} from '../../src/permissions/fields.js';

describe('Field Permissions', () => {
  // ========================================================================
  // fields.hidden()
  // ========================================================================

  describe('fields.hidden()', () => {
    const permissions: FieldPermissionMap = {
      password: fields.hidden(),
      secret: fields.hidden(),
    };

    it('should strip hidden fields from reads for all roles', () => {
      const data = { name: 'John', email: 'j@example.com', password: 'hash123', secret: 'xyz' };

      const result = applyFieldReadPermissions(data, permissions, ['admin']);
      expect(result.name).toBe('John');
      expect(result.email).toBe('j@example.com');
      expect(result).not.toHaveProperty('password');
      expect(result).not.toHaveProperty('secret');
    });

    it('should strip hidden fields even for unauthenticated users', () => {
      const data = { name: 'John', password: 'hash123' };

      const result = applyFieldReadPermissions(data, permissions, []);
      expect(result.name).toBe('John');
      expect(result).not.toHaveProperty('password');
    });

    it('should strip hidden fields from writes', () => {
      const body = { name: 'John', password: 'newpass', secret: 'new-secret' };

      const result = applyFieldWritePermissions(body, permissions, ['admin']);
      expect(result.name).toBe('John');
      expect(result).not.toHaveProperty('password');
      expect(result).not.toHaveProperty('secret');
    });
  });

  // ========================================================================
  // fields.visibleTo(roles)
  // ========================================================================

  describe('fields.visibleTo(roles)', () => {
    const permissions: FieldPermissionMap = {
      salary: fields.visibleTo(['admin', 'hr']),
      internalNotes: fields.visibleTo(['admin']),
    };

    it('should show field to users with matching role', () => {
      const data = { name: 'John', salary: 50000, internalNotes: 'good employee' };

      const result = applyFieldReadPermissions(data, permissions, ['admin']);
      expect(result.salary).toBe(50000);
      expect(result.internalNotes).toBe('good employee');
    });

    it('should show field when user has one matching role (OR logic)', () => {
      const data = { name: 'John', salary: 50000, internalNotes: 'good' };

      const result = applyFieldReadPermissions(data, permissions, ['hr']);
      expect(result.salary).toBe(50000);
      // hr doesn't have access to internalNotes
      expect(result).not.toHaveProperty('internalNotes');
    });

    it('should strip field for users without matching role', () => {
      const data = { name: 'John', salary: 50000, internalNotes: 'good' };

      const result = applyFieldReadPermissions(data, permissions, ['viewer']);
      expect(result.name).toBe('John');
      expect(result).not.toHaveProperty('salary');
      expect(result).not.toHaveProperty('internalNotes');
    });

    it('should strip field for unauthenticated users (empty roles)', () => {
      const data = { name: 'John', salary: 50000 };

      const result = applyFieldReadPermissions(data, permissions, []);
      expect(result).not.toHaveProperty('salary');
    });

    it('should NOT affect writes (visibleTo is read-only)', () => {
      const body = { name: 'John', salary: 60000 };

      // visibleTo doesn't restrict writes
      const result = applyFieldWritePermissions(body, permissions, ['viewer']);
      expect(result.salary).toBe(60000);
    });
  });

  // ========================================================================
  // fields.writableBy(roles)
  // ========================================================================

  describe('fields.writableBy(roles)', () => {
    const permissions: FieldPermissionMap = {
      role: fields.writableBy(['admin']),
      isVerified: fields.writableBy(['admin', 'moderator']),
    };

    it('should allow write when user has matching role', () => {
      const body = { name: 'John', role: 'editor', isVerified: true };

      const result = applyFieldWritePermissions(body, permissions, ['admin']);
      expect(result.role).toBe('editor');
      expect(result.isVerified).toBe(true);
    });

    it('should strip field from writes when user lacks role', () => {
      const body = { name: 'John', role: 'admin', isVerified: true };

      const result = applyFieldWritePermissions(body, permissions, ['viewer']);
      expect(result.name).toBe('John');
      expect(result).not.toHaveProperty('role');
      expect(result).not.toHaveProperty('isVerified');
    });

    it('should NOT affect reads (writableBy is write-only)', () => {
      const data = { name: 'John', role: 'editor', isVerified: true };

      // writableBy doesn't restrict reads
      const result = applyFieldReadPermissions(data, permissions, ['viewer']);
      expect(result.role).toBe('editor');
      expect(result.isVerified).toBe(true);
    });

    it('should only strip fields present in the body', () => {
      const body = { name: 'John' }; // role is not in body

      const result = applyFieldWritePermissions(body, permissions, ['viewer']);
      expect(result).toEqual({ name: 'John' });
    });
  });

  // ========================================================================
  // fields.redactFor(roles)
  // ========================================================================

  describe('fields.redactFor(roles)', () => {
    const permissions: FieldPermissionMap = {
      email: fields.redactFor(['viewer']),
      ssn: fields.redactFor(['basic'], '***-**-****'),
    };

    it('should redact field for matching roles with default placeholder', () => {
      const data = { name: 'John', email: 'john@example.com' };

      const result = applyFieldReadPermissions(data, permissions, ['viewer']);
      expect(result.email).toBe('***');
    });

    it('should redact field with custom placeholder', () => {
      const data = { name: 'John', ssn: '123-45-6789' };

      const result = applyFieldReadPermissions(data, permissions, ['basic']);
      expect(result.ssn).toBe('***-**-****');
    });

    it('should show real value to non-matching roles', () => {
      const data = { name: 'John', email: 'john@example.com', ssn: '123-45-6789' };

      const result = applyFieldReadPermissions(data, permissions, ['admin']);
      expect(result.email).toBe('john@example.com');
      expect(result.ssn).toBe('123-45-6789');
    });

    it('should show real value to unauthenticated users (empty roles)', () => {
      const data = { name: 'John', email: 'john@example.com' };

      // redactFor targets specific roles — empty roles don't match
      const result = applyFieldReadPermissions(data, permissions, []);
      expect(result.email).toBe('john@example.com');
    });

    it('should NOT affect writes (redactFor is read-only)', () => {
      const body = { email: 'new@example.com' };

      const result = applyFieldWritePermissions(body, permissions, ['viewer']);
      expect(result.email).toBe('new@example.com');
    });
  });

  // ========================================================================
  // Combined Permissions
  // ========================================================================

  describe('Combined permissions', () => {
    const permissions: FieldPermissionMap = {
      password: fields.hidden(),
      salary: fields.visibleTo(['admin', 'hr']),
      role: fields.writableBy(['admin']),
      email: fields.redactFor(['viewer']),
    };

    it('should apply all permission types together on reads', () => {
      const data = {
        name: 'John',
        password: 'hash',
        salary: 50000,
        role: 'editor',
        email: 'john@example.com',
      };

      // Admin sees everything except password
      const adminResult = applyFieldReadPermissions(data, permissions, ['admin']);
      expect(adminResult).not.toHaveProperty('password');
      expect(adminResult.salary).toBe(50000);
      expect(adminResult.role).toBe('editor');
      expect(adminResult.email).toBe('john@example.com');

      // Viewer sees redacted email, no salary, no password
      const viewerResult = applyFieldReadPermissions(data, permissions, ['viewer']);
      expect(viewerResult).not.toHaveProperty('password');
      expect(viewerResult).not.toHaveProperty('salary');
      expect(viewerResult.role).toBe('editor');
      expect(viewerResult.email).toBe('***');
    });

    it('should apply all permission types together on writes', () => {
      const body = {
        name: 'John',
        password: 'newpass',
        salary: 60000,
        role: 'admin',
        email: 'new@example.com',
      };

      // Admin can write role but not password
      const adminResult = applyFieldWritePermissions(body, permissions, ['admin']);
      expect(adminResult).not.toHaveProperty('password');
      expect(adminResult.role).toBe('admin');
      expect(adminResult.email).toBe('new@example.com');

      // Viewer can't write password or role
      const viewerResult = applyFieldWritePermissions(body, permissions, ['viewer']);
      expect(viewerResult).not.toHaveProperty('password');
      expect(viewerResult).not.toHaveProperty('role');
      expect(viewerResult.email).toBe('new@example.com');
    });
  });

  // ========================================================================
  // Edge Cases
  // ========================================================================

  describe('Edge cases', () => {
    it('should handle null/undefined data gracefully', () => {
      const permissions: FieldPermissionMap = { password: fields.hidden() };

      const result = applyFieldReadPermissions(null as any, permissions, ['admin']);
      expect(result).toBeNull();
    });

    it('should handle empty permission map', () => {
      const data = { name: 'John', email: 'j@example.com' };
      const result = applyFieldReadPermissions(data, {}, ['admin']);
      expect(result).toEqual(data);
    });

    it('should not mutate the original data object', () => {
      const permissions: FieldPermissionMap = { password: fields.hidden() };
      const original = { name: 'John', password: 'hash' };

      applyFieldReadPermissions(original, permissions, ['admin']);
      // Original should still have password
      expect(original.password).toBe('hash');
    });

    it('should not mutate the original body object', () => {
      const permissions: FieldPermissionMap = { role: fields.writableBy(['admin']) };
      const original = { name: 'John', role: 'admin' };

      applyFieldWritePermissions(original, permissions, ['viewer']);
      // Original should still have role
      expect(original.role).toBe('admin');
    });
  });
});
