/**
 * defineEvent + Typed Event Registry Tests
 *
 * Tests the defineEvent() primitive which provides:
 * 1. Runtime payload validation at publish-time
 * 2. Event catalog for introspection/docs
 * 3. Type-safe event creation helper
 */

import { describe, it, expect, vi } from 'vitest';
import {
  defineEvent,
  createEventRegistry,
  type EventSchema,
} from '../../src/events/defineEvent.js';
import { MemoryEventTransport, createEvent } from '../../src/events/EventTransport.js';

// ============================================================================
// defineEvent()
// ============================================================================

describe('defineEvent()', () => {
  it('should create an event definition with name and schema', () => {
    const OrderCreated = defineEvent({
      name: 'order.created',
      schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          total: { type: 'number' },
        },
        required: ['orderId', 'total'],
      },
    });

    expect(OrderCreated.name).toBe('order.created');
    expect(OrderCreated.schema).toBeDefined();
    expect(OrderCreated.schema!.required).toEqual(['orderId', 'total']);
  });

  it('should create an event definition without schema (unvalidated)', () => {
    const SystemLog = defineEvent({
      name: 'system.log',
      description: 'General system log event',
    });

    expect(SystemLog.name).toBe('system.log');
    expect(SystemLog.schema).toBeUndefined();
    expect(SystemLog.description).toBe('General system log event');
  });

  it('should support version field for schema evolution', () => {
    const OrderCreatedV2 = defineEvent({
      name: 'order.created',
      version: 2,
      schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          total: { type: 'number' },
          currency: { type: 'string' },
        },
        required: ['orderId', 'total', 'currency'],
      },
    });

    expect(OrderCreatedV2.version).toBe(2);
  });

  it('should provide a typed create() helper that builds DomainEvent', () => {
    const ProductUpdated = defineEvent({
      name: 'product.updated',
      schema: {
        type: 'object',
        properties: {
          productId: { type: 'string' },
          changes: { type: 'object' },
        },
        required: ['productId'],
      },
    });

    const event = ProductUpdated.create(
      { productId: 'p-1', changes: { price: 99 } },
      { userId: 'user-1' },
    );

    expect(event.type).toBe('product.updated');
    expect(event.payload).toEqual({ productId: 'p-1', changes: { price: 99 } });
    expect(event.meta.userId).toBe('user-1');
    expect(event.meta.id).toBeDefined();
    expect(event.meta.timestamp).toBeInstanceOf(Date);
  });
});

// ============================================================================
// EventRegistry
// ============================================================================

describe('EventRegistry', () => {
  it('should register events and provide catalog', () => {
    const registry = createEventRegistry();

    const OrderCreated = defineEvent({ name: 'order.created', description: 'Order was placed' });
    const OrderShipped = defineEvent({ name: 'order.shipped', description: 'Order was shipped' });

    registry.register(OrderCreated);
    registry.register(OrderShipped);

    const catalog = registry.catalog();
    expect(catalog).toHaveLength(2);
    expect(catalog.map((e) => e.name)).toEqual(['order.created', 'order.shipped']);
  });

  it('should reject duplicate event names', () => {
    const registry = createEventRegistry();

    const evt1 = defineEvent({ name: 'order.created' });
    const evt2 = defineEvent({ name: 'order.created' });

    registry.register(evt1);
    expect(() => registry.register(evt2)).toThrow(/already registered/);
  });

  it('should allow duplicate names with different versions', () => {
    const registry = createEventRegistry();

    const v1 = defineEvent({ name: 'order.created', version: 1 });
    const v2 = defineEvent({ name: 'order.created', version: 2 });

    registry.register(v1);
    registry.register(v2);

    const catalog = registry.catalog();
    expect(catalog).toHaveLength(2);
  });

  it('should look up event definition by name', () => {
    const registry = createEventRegistry();

    const OrderCreated = defineEvent({
      name: 'order.created',
      schema: { type: 'object', properties: { orderId: { type: 'string' } } },
    });
    registry.register(OrderCreated);

    const found = registry.get('order.created');
    expect(found).toBeDefined();
    expect(found!.schema).toBeDefined();
  });

  it('should return undefined for unknown event', () => {
    const registry = createEventRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });
});

// ============================================================================
// Validated publish via registry
// ============================================================================

describe('EventRegistry — validated publish', () => {
  it('should validate payload against schema on publish', async () => {
    const registry = createEventRegistry();

    const OrderCreated = defineEvent({
      name: 'order.created',
      schema: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          total: { type: 'number' },
        },
        required: ['orderId', 'total'],
      },
    });
    registry.register(OrderCreated);

    // Valid payload
    const validResult = registry.validate('order.created', { orderId: 'o-1', total: 100 });
    expect(validResult.valid).toBe(true);

    // Invalid payload (missing required field)
    const invalidResult = registry.validate('order.created', { orderId: 'o-1' });
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors).toBeDefined();
    expect(invalidResult.errors!.length).toBeGreaterThan(0);
  });

  it('should pass validation for events with no schema (unvalidated)', () => {
    const registry = createEventRegistry();

    const SystemLog = defineEvent({ name: 'system.log' });
    registry.register(SystemLog);

    const result = registry.validate('system.log', { anything: 'goes' });
    expect(result.valid).toBe(true);
  });

  it('should pass validation for unknown events (not registered)', () => {
    const registry = createEventRegistry();

    // Unknown events pass validation — registry is opt-in, not blocking
    const result = registry.validate('unknown.event', { data: 1 });
    expect(result.valid).toBe(true);
  });

  it('should validate nested object schemas', () => {
    const registry = createEventRegistry();

    const PaymentProcessed = defineEvent({
      name: 'payment.processed',
      schema: {
        type: 'object',
        properties: {
          paymentId: { type: 'string' },
          amount: { type: 'number' },
          metadata: {
            type: 'object',
            properties: {
              gateway: { type: 'string' },
            },
          },
        },
        required: ['paymentId', 'amount'],
      },
    });
    registry.register(PaymentProcessed);

    const valid = registry.validate('payment.processed', {
      paymentId: 'pay-1',
      amount: 50,
      metadata: { gateway: 'stripe' },
    });
    expect(valid.valid).toBe(true);

    const invalid = registry.validate('payment.processed', {
      paymentId: 'pay-1',
      // missing amount
    });
    expect(invalid.valid).toBe(false);
  });

  it('built-in validator only checks top-level types (does not recurse)', () => {
    const registry = createEventRegistry();

    const WithNested = defineEvent({
      name: 'with.nested',
      schema: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              value: { type: 'number' },
            },
            required: ['value'],
          },
        },
        required: ['data'],
      },
    });
    registry.register(WithNested);

    // Built-in validator: checks data is an object — passes
    // Does NOT check data.value exists or is a number
    const result = registry.validate('with.nested', {
      data: { wrongField: 'not a number' }, // missing required 'value'
    });
    // Built-in validator passes because it only checks top-level
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Custom Validator
// ============================================================================

describe('EventRegistry — custom validator', () => {
  it('uses custom validator when provided', () => {
    const customValidate = vi.fn().mockReturnValue({ valid: true });

    const registry = createEventRegistry({ validate: customValidate });

    const TestEvent = defineEvent({
      name: 'test.event',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    });
    registry.register(TestEvent);

    const result = registry.validate('test.event', { id: 'abc' });
    expect(result.valid).toBe(true);
    expect(customValidate).toHaveBeenCalledOnce();
    expect(customValidate).toHaveBeenCalledWith(
      TestEvent.schema,
      { id: 'abc' },
    );
  });

  it('custom validator can reject payloads the built-in passes', () => {
    // Strict validator that checks nested required fields
    const strictValidate = (_schema: unknown, payload: unknown) => {
      const p = payload as Record<string, unknown>;
      const data = p.data as Record<string, unknown> | undefined;
      if (!data || typeof data.value !== 'number') {
        return { valid: false, errors: ['data.value must be a number'] };
      }
      return { valid: true };
    };

    const registry = createEventRegistry({ validate: strictValidate });

    const WithNested = defineEvent({
      name: 'with.nested',
      schema: {
        type: 'object',
        properties: { data: { type: 'object' } },
        required: ['data'],
      },
    });
    registry.register(WithNested);

    // Same payload that built-in validator passes
    const result = registry.validate('with.nested', {
      data: { wrongField: 'not a number' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('data.value must be a number');
  });

  it('custom validator is not called for unknown events', () => {
    const customValidate = vi.fn();
    const registry = createEventRegistry({ validate: customValidate });

    const result = registry.validate('unknown.event', { anything: true });
    expect(result.valid).toBe(true);
    expect(customValidate).not.toHaveBeenCalled();
  });

  it('custom validator is not called for events without schema', () => {
    const customValidate = vi.fn();
    const registry = createEventRegistry({ validate: customValidate });

    const NoSchema = defineEvent({ name: 'no.schema' });
    registry.register(NoSchema);

    const result = registry.validate('no.schema', { anything: true });
    expect(result.valid).toBe(true);
    expect(customValidate).not.toHaveBeenCalled();
  });

  it('no custom validator = built-in used (backward compatible)', () => {
    const registry = createEventRegistry(); // no options

    const TestEvent = defineEvent({
      name: 'test.event',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    });
    registry.register(TestEvent);

    // Missing required field — built-in catches this
    const result = registry.validate('test.event', {});
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });
});
