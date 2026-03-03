/**
 * QueryResolver Tests
 *
 * Tests query parsing into pagination/sort/filters, max limit enforcement,
 * org/tenant scope application, select/populate sanitization, and updateSchemaOptions.
 */

import { describe, it, expect } from 'vitest';
import { QueryResolver } from '../../src/core/QueryResolver.js';
import type { IRequestContext, ArcInternalMetadata, RouteSchemaOptions } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function createResolver(config: ConstructorParameters<typeof QueryResolver>[0] = {}) {
  return new QueryResolver(config);
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

describe('QueryResolver', () => {
  // --------------------------------------------------------------------------
  // Basic query parsing
  // --------------------------------------------------------------------------

  describe('basic query parsing', () => {
    it('returns default pagination when no query params', () => {
      const resolver = createResolver();
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.sort).toBe('-createdAt');
    });

    it('parses page and limit from query', () => {
      const resolver = createResolver();
      const req = createReq({ query: { page: '3', limit: '50' } });

      const result = resolver.resolve(req);

      expect(result.page).toBe(3);
      expect(result.limit).toBe(50);
    });

    it('parses sort from query', () => {
      const resolver = createResolver();
      const req = createReq({ query: { sort: '-price,name' } });

      const result = resolver.resolve(req);

      expect(result.sort).toBe('-price,name');
    });

    it('uses default sort when no sort provided', () => {
      const resolver = createResolver({ defaultSort: '-updatedAt' });
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.sort).toBe('-updatedAt');
    });

    it('parses filters from query', () => {
      const resolver = createResolver();
      const req = createReq({
        query: { status: 'active', category: 'electronics' },
      });

      const result = resolver.resolve(req);

      expect(result.filters?.status).toBe('active');
      expect(result.filters?.category).toBe('electronics');
    });

    it('parses search from query', () => {
      const resolver = createResolver();
      const req = createReq({ query: { search: 'laptop' } });

      const result = resolver.resolve(req);

      expect(result.search).toBe('laptop');
    });

    it('parses populate from query', () => {
      const resolver = createResolver();
      const req = createReq({ query: { populate: 'author,category' } });

      const result = resolver.resolve(req);

      expect(result.populate).toEqual(['author', 'category']);
    });

    it('parses select from query', () => {
      const resolver = createResolver();
      const req = createReq({ query: { select: 'name,price,-password' } });

      const result = resolver.resolve(req);

      expect(result.select).toBe('name price -password');
    });
  });

  // --------------------------------------------------------------------------
  // Max limit enforcement
  // --------------------------------------------------------------------------

  describe('max limit enforcement', () => {
    it('enforces default max limit of 100', () => {
      const resolver = createResolver();
      const req = createReq({ query: { limit: '500' } });

      const result = resolver.resolve(req);

      expect(result.limit).toBe(100);
    });

    it('enforces custom max limit', () => {
      const resolver = createResolver({ maxLimit: 50 });
      const req = createReq({ query: { limit: '100' } });

      const result = resolver.resolve(req);

      expect(result.limit).toBe(50);
    });

    it('enforces minimum limit of 1', () => {
      const resolver = createResolver();
      const req = createReq({ query: { limit: '0' } });

      const result = resolver.resolve(req);

      expect(result.limit).toBeGreaterThanOrEqual(1);
    });

    it('uses custom default limit when parser returns no limit', () => {
      // The ArcQueryParser has its own default limit (20), so the resolver's
      // defaultLimit only applies when using a custom parser that returns no limit.
      const customParser = {
        parse: () => ({ filters: {}, limit: 0 }),
      };
      const resolver = createResolver({ defaultLimit: 10, queryParser: customParser });
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.limit).toBe(10);
    });
  });

  // --------------------------------------------------------------------------
  // Org/tenant scope application
  // --------------------------------------------------------------------------

  describe('org/tenant scope application', () => {
    it('applies org scope filter for member scope', () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['user'] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.organizationId).toBe('org-1');
    });

    it('applies org scope filter for elevated scope with orgId', () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: 'elevated', organizationId: 'org-1', elevatedBy: 'admin' },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.organizationId).toBe('org-1');
    });

    it('does not apply org scope for elevated scope without orgId', () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: 'elevated', elevatedBy: 'admin' },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.organizationId).toBeUndefined();
    });

    it('does not apply org scope for public scope', () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: 'public' },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.organizationId).toBeUndefined();
    });

    it('does not override org scope already set by policy filters', () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _policyFilters: { organizationId: 'policy-org' },
          _scope: { kind: 'member', organizationId: 'scope-org', orgRoles: [] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      // Policy filter org wins over scope org
      expect(result.filters?.organizationId).toBe('policy-org');
    });

    it('uses custom tenantField', () => {
      const resolver = createResolver({ tenantField: 'workspaceId' });
      const req = createReq({
        metadata: {
          _scope: { kind: 'member', organizationId: 'ws-1', orgRoles: [] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.workspaceId).toBe('ws-1');
      expect(result.filters?.organizationId).toBeUndefined();
    });

    it('skips org filter when tenantField is false (platform-universal)', () => {
      const resolver = createResolver({ tenantField: false });
      const req = createReq({
        metadata: {
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['admin'] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      // No org filter applied — platform-universal
      expect(result.filters?.organizationId).toBeUndefined();
    });

    it('still applies policy filters when tenantField is false', () => {
      const resolver = createResolver({ tenantField: false });
      const req = createReq({
        metadata: {
          _policyFilters: { status: 'active' },
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['user'] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      // Policy filters work, but org filter is skipped
      expect(result.filters?.status).toBe('active');
      expect(result.filters?.organizationId).toBeUndefined();
    });

    it('applies query filters normally when tenantField is false', () => {
      const resolver = createResolver({ tenantField: false });
      const req = createReq({
        query: { status: 'pending', category: 'electronics' },
        metadata: {
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: [] },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.status).toBe('pending');
      expect(result.filters?.category).toBe('electronics');
      expect(result.filters?.organizationId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Policy filters
  // --------------------------------------------------------------------------

  describe('policy filter application', () => {
    it('merges policy filters into query filters', () => {
      const resolver = createResolver();
      const req = createReq({
        query: { status: 'active' },
        metadata: {
          _policyFilters: { department: 'engineering' },
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.filters?.status).toBe('active');
      expect(result.filters?.department).toBe('engineering');
    });

    it('strips _policyFilters from filters (internal param)', () => {
      const resolver = createResolver();
      const req = createReq({
        query: { _policyFilters: 'should-be-stripped' },
      });

      const result = resolver.resolve(req);

      expect(result.filters?._policyFilters).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Select field sanitization
  // --------------------------------------------------------------------------

  describe('select field sanitization', () => {
    it('blocks systemManaged fields from select', () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            internalScore: { systemManaged: true },
          },
        },
      });
      const req = createReq({ query: { select: 'name,internalScore,price' } });

      const result = resolver.resolve(req);

      // internalScore should be filtered out
      expect(result.select).not.toContain('internalScore');
      expect(result.select).toContain('name');
      expect(result.select).toContain('price');
    });

    it('blocks hidden fields from select', () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            password: { hidden: true },
          },
        },
      });
      const req = createReq({ query: { select: 'name,password,email' } });

      const result = resolver.resolve(req);

      expect(result.select).not.toContain('password');
      expect(result.select).toContain('name');
      expect(result.select).toContain('email');
    });

    it('returns undefined select when all fields are blocked', () => {
      const resolver = createResolver({
        schemaOptions: {
          fieldRules: {
            password: { hidden: true },
          },
        },
      });
      const req = createReq({ query: { select: 'password' } });

      const result = resolver.resolve(req);

      expect(result.select).toBeUndefined();
    });

    it('allows select when no blocked fields', () => {
      const resolver = createResolver();
      const req = createReq({ query: { select: 'name,price' } });

      const result = resolver.resolve(req);

      expect(result.select).toBe('name price');
    });
  });

  // --------------------------------------------------------------------------
  // Populate field sanitization
  // --------------------------------------------------------------------------

  describe('populate field sanitization', () => {
    it('filters populate against allowedPopulate list', () => {
      const resolver = createResolver({
        schemaOptions: {
          query: { allowedPopulate: ['author', 'category'] },
        },
      });
      const req = createReq({ query: { populate: 'author,secret,category' } });

      const result = resolver.resolve(req);

      expect(result.populate).toEqual(['author', 'category']);
    });

    it('allows all populate when no allowedPopulate is defined', () => {
      const resolver = createResolver();
      const req = createReq({ query: { populate: 'author,anything' } });

      const result = resolver.resolve(req);

      expect(result.populate).toEqual(['author', 'anything']);
    });

    it('returns undefined populate when no allowed fields match', () => {
      const resolver = createResolver({
        schemaOptions: {
          query: { allowedPopulate: ['author'] },
        },
      });
      const req = createReq({ query: { populate: 'secret' } });

      const result = resolver.resolve(req);

      expect(result.populate).toBeUndefined();
    });

    it('returns undefined populate when not provided', () => {
      const resolver = createResolver();
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.populate).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Keyset pagination (after/cursor)
  // --------------------------------------------------------------------------

  describe('keyset pagination', () => {
    it('sets page to undefined when using after/cursor pagination', () => {
      const resolver = createResolver();
      const req = createReq({ query: { after: 'cursor-abc123', limit: '10' } });

      const result = resolver.resolve(req);

      expect(result.after).toBe('cursor-abc123');
      expect(result.page).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Page normalization
  // --------------------------------------------------------------------------

  describe('page normalization', () => {
    it('ensures page is at least 1', () => {
      const resolver = createResolver();
      const req = createReq({ query: { page: '0' } });

      const result = resolver.resolve(req);

      expect(result.page).toBeGreaterThanOrEqual(1);
    });

    it('defaults page to 1 when not provided', () => {
      const resolver = createResolver();
      const req = createReq();

      const result = resolver.resolve(req);

      expect(result.page).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // User and context passthrough
  // --------------------------------------------------------------------------

  describe('user and context passthrough', () => {
    it('passes user through to query options', () => {
      const resolver = createResolver();
      const user = { _id: 'user-1', email: 'test@example.com', role: ['user'] };
      const req = createReq({ user });

      const result = resolver.resolve(req);

      expect(result.user).toEqual(user);
    });

    it('passes arcContext through as context', () => {
      const resolver = createResolver();
      const req = createReq({
        metadata: {
          _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['user'] },
          customField: 'test',
        } as unknown as Record<string, unknown>,
      });

      const result = resolver.resolve(req);

      expect(result.context).toBeDefined();
      expect((result.context as ArcInternalMetadata)?._scope).toEqual({
        kind: 'member',
        organizationId: 'org-1',
        orgRoles: ['user'],
      });
    });
  });

  // --------------------------------------------------------------------------
  // Sort object-to-string conversion
  // --------------------------------------------------------------------------

  describe('sort conversion', () => {
    it('converts parsed sort object back to sort string', () => {
      const resolver = createResolver();
      // The Arc query parser parses sort: '-price,name' into { price: -1, name: 1 }
      // The resolver converts it back to a string for downstream consumers
      const req = createReq({ query: { sort: '-price,name' } });

      const result = resolver.resolve(req);

      // Should be a string (not an object)
      expect(typeof result.sort).toBe('string');
      // Should contain the sort fields
      expect(result.sort).toContain('price');
      expect(result.sort).toContain('name');
    });
  });

  // --------------------------------------------------------------------------
  // External metadata injection
  // --------------------------------------------------------------------------

  describe('external metadata injection', () => {
    it('accepts metadata parameter to override req.metadata', () => {
      const resolver = createResolver();
      const req = createReq();
      const meta: ArcInternalMetadata = {
        _scope: { kind: 'member', organizationId: 'injected-org', orgRoles: [] },
      };

      const result = resolver.resolve(req, meta);

      expect(result.filters?.organizationId).toBe('injected-org');
    });
  });
});
