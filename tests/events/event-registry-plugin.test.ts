/**
 * EventRegistry + eventPlugin Integration Tests
 *
 * Tests that the optional registry on eventPlugin auto-validates
 * payloads on publish in warn or reject mode.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eventPlugin } from '../../src/events/eventPlugin.js';
import { defineEvent, createEventRegistry } from '../../src/events/defineEvent.js';

describe('eventPlugin — registry integration', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
  });

  // ========================================
  // warn mode (default)
  // ========================================

  it('should warn on invalid payload in "warn" mode (default)', async () => {
    const registry = createEventRegistry();
    registry.register(defineEvent({
      name: 'order.created',
      schema: {
        type: 'object',
        properties: { orderId: { type: 'string' }, total: { type: 'number' } },
        required: ['orderId', 'total'],
      },
    }));

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { registry, validateMode: 'warn' });
    await app.ready();

    const warnSpy = vi.spyOn(app.log, 'warn');

    // Publish with missing required field — should warn, not throw
    await app.events.publish('order.created', { orderId: 'o-1' }); // missing total

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toMatch(/validation failed/i);
  });

  it('should NOT warn on valid payload in "warn" mode', async () => {
    const registry = createEventRegistry();
    registry.register(defineEvent({
      name: 'order.created',
      schema: {
        type: 'object',
        properties: { orderId: { type: 'string' }, total: { type: 'number' } },
        required: ['orderId', 'total'],
      },
    }));

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { registry, validateMode: 'warn' });
    await app.ready();

    const warnSpy = vi.spyOn(app.log, 'warn');

    // Valid payload
    await app.events.publish('order.created', { orderId: 'o-1', total: 100 });

    // Only the standard "memory transport" warning, not validation warning
    const validationWarns = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('validation'),
    );
    expect(validationWarns).toHaveLength(0);
  });

  // ========================================
  // reject mode
  // ========================================

  it('should throw on invalid payload in "reject" mode', async () => {
    const registry = createEventRegistry();
    registry.register(defineEvent({
      name: 'payment.processed',
      schema: {
        type: 'object',
        properties: { paymentId: { type: 'string' }, amount: { type: 'number' } },
        required: ['paymentId', 'amount'],
      },
    }));

    app = Fastify({ logger: false });
    await app.register(eventPlugin, {
      registry,
      validateMode: 'reject',
      failOpen: false, // Must be false for reject to actually throw
    });
    await app.ready();

    await expect(
      app.events.publish('payment.processed', { paymentId: 'p-1' }), // missing amount
    ).rejects.toThrow(/validation failed/i);
  });

  it('should allow valid payload in "reject" mode', async () => {
    const registry = createEventRegistry();
    registry.register(defineEvent({
      name: 'payment.processed',
      schema: {
        type: 'object',
        properties: { paymentId: { type: 'string' }, amount: { type: 'number' } },
        required: ['paymentId', 'amount'],
      },
    }));

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { registry, validateMode: 'reject', failOpen: false });
    await app.ready();

    // Should not throw
    await app.events.publish('payment.processed', { paymentId: 'p-1', amount: 50 });
  });

  // ========================================
  // off mode / no registry
  // ========================================

  it('should skip validation when validateMode is "off"', async () => {
    const registry = createEventRegistry();
    registry.register(defineEvent({
      name: 'strict.event',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    }));

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { registry, validateMode: 'off' });
    await app.ready();

    // Invalid payload — should pass without warning or error
    await app.events.publish('strict.event', {}); // missing required 'id'
  });

  it('should skip validation when no registry is provided', async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin); // no registry
    await app.ready();

    // Any payload — no validation
    await app.events.publish('anything', { whatever: true });
  });

  // ========================================
  // unregistered events pass through
  // ========================================

  it('should not validate events that are not in the registry', async () => {
    const registry = createEventRegistry();
    // Only register order.created — nothing else
    registry.register(defineEvent({
      name: 'order.created',
      schema: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
    }));

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { registry, validateMode: 'reject', failOpen: false });
    await app.ready();

    // Unregistered event — should pass through without validation
    await app.events.publish('system.log', { message: 'hello' });
  });

  // ========================================
  // registry exposed on fastify.events
  // ========================================

  it('should expose registry on fastify.events for introspection', async () => {
    const registry = createEventRegistry();
    registry.register(defineEvent({ name: 'test.event', description: 'A test event' }));

    app = Fastify({ logger: false });
    await app.register(eventPlugin, { registry });
    await app.ready();

    expect(app.events.registry).toBe(registry);
  });

  it('should have undefined registry when none provided', async () => {
    app = Fastify({ logger: false });
    await app.register(eventPlugin);
    await app.ready();

    expect(app.events.registry).toBeUndefined();
  });
});
