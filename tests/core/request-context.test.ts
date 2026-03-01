/**
 * IRequestContext — context & metadata population tests
 *
 * Verifies that createRequestContext() populates:
 * - req.context (typed context for controller overrides)
 * - req.metadata (includes Arc internals + _scope)
 *
 * Also tests the getControllerContext() and getControllerScope() helpers.
 */

import { describe, it, expect } from 'vitest';
import { createRequestContext, getControllerContext, getControllerScope } from '../../src/core/fastifyAdapter.js';
import type { IRequestContext } from '../../src/types/handlers.js';

/** Minimal mock Fastify request */
function mockRequest(overrides: Record<string, unknown> = {}): any {
  return {
    query: {},
    body: {},
    params: {},
    headers: {},
    user: overrides.user ?? null,
    scope: overrides.scope ?? undefined,
    context: overrides.context ?? undefined,
    arc: overrides.arc ?? undefined,
    _policyFilters: overrides._policyFilters ?? undefined,
    _ownershipCheck: overrides._ownershipCheck ?? undefined,
    log: overrides.log ?? undefined,
  };
}

describe('createRequestContext', () => {
  it('populates metadata._scope from request.scope', () => {
    const req = mockRequest({
      scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['admin', 'delivery_manager'] },
    });

    const ctx = createRequestContext(req);

    expect((ctx.metadata as any)?._scope).toEqual({
      kind: 'member',
      organizationId: 'org-1',
      orgRoles: ['admin', 'delivery_manager'],
    });
  });

  it('populates metadata with context spread + Arc internals', () => {
    const req = mockRequest({
      context: { customField: 'hello' },
      _policyFilters: { status: 'active' },
      arc: { resourceName: 'job' },
    });

    const ctx = createRequestContext(req);

    // metadata includes context fields
    expect((ctx.metadata as any)?.customField).toBe('hello');

    // metadata includes Arc internals
    expect((ctx.metadata as any)?._policyFilters).toEqual({ status: 'active' });
    expect((ctx.metadata as any)?.arc).toEqual({ resourceName: 'job' });
  });

  it('sets empty context when no request.context exists', () => {
    const req = mockRequest();
    const ctx = createRequestContext(req);

    expect(ctx.context).toBeDefined();
  });

  it('normalizes user ID for MongoDB compatibility', () => {
    const req = mockRequest({
      user: { id: 'user-123', name: 'Test', email: 'test@test.com' },
    });

    const ctx = createRequestContext(req);

    expect(ctx.user?.id).toBe('user-123');
    expect(ctx.user?._id).toBe('user-123');
  });
});

describe('getControllerContext', () => {
  it('returns context when available', () => {
    const req: IRequestContext = {
      params: {},
      query: {},
      body: {},
      user: null,
      headers: {},
      context: {
        customField: 'test',
      },
      metadata: {
        customField: 'test',
        _policyFilters: { foo: 'bar' },
      },
    };

    const ctx = getControllerContext(req);

    expect(ctx.customField).toBe('test');
  });

  it('falls back to metadata when context is undefined', () => {
    const req: IRequestContext = {
      params: {},
      query: {},
      body: {},
      user: null,
      headers: {},
      metadata: {
        customField: 'from-metadata',
      },
    };

    const ctx = getControllerContext(req);

    expect(ctx.customField).toBe('from-metadata');
  });

  it('returns empty object when neither is set', () => {
    const req: IRequestContext = {
      params: {},
      query: {},
      body: {},
      user: null,
      headers: {},
    };

    const ctx = getControllerContext(req);

    expect(ctx).toEqual({});
  });
});

describe('getControllerScope', () => {
  it('returns scope from metadata._scope', () => {
    const req: IRequestContext = {
      params: {},
      query: {},
      body: {},
      user: null,
      headers: {},
      metadata: {
        _scope: { kind: 'member', organizationId: 'org-1', orgRoles: ['admin'] },
      },
    };

    const scope = getControllerScope(req);

    expect(scope.kind).toBe('member');
    if (scope.kind === 'member') {
      expect(scope.organizationId).toBe('org-1');
      expect(scope.orgRoles).toEqual(['admin']);
    }
  });

  it('returns elevated scope', () => {
    const req: IRequestContext = {
      params: {},
      query: {},
      body: {},
      user: null,
      headers: {},
      metadata: {
        _scope: { kind: 'elevated', elevatedBy: 'admin-1' },
      },
    };

    const scope = getControllerScope(req);

    expect(scope.kind).toBe('elevated');
  });

  it('defaults to public when no scope set', () => {
    const req: IRequestContext = {
      params: {},
      query: {},
      body: {},
      user: null,
      headers: {},
    };

    const scope = getControllerScope(req);

    expect(scope).toEqual({ kind: 'public' });
  });
});
