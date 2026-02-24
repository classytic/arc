/**
 * EventLogger Injectable Logger Tests
 *
 * Validates that all event transports and retry logic properly use
 * the injectable logger instead of console, and that the default
 * fallback (console) still works.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MemoryEventTransport,
  createEvent,
  type EventLogger,
} from '../../src/events/EventTransport.js';
import { withRetry } from '../../src/events/retry.js';
import { RedisEventTransport, type RedisLike } from '../../src/events/transports/redis.js';
import { RedisStreamTransport, type RedisStreamLike } from '../../src/events/transports/redis-stream.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock logger that captures all calls */
function createMockLogger(): EventLogger & {
  warnCalls: unknown[][];
  errorCalls: unknown[][];
} {
  const warnCalls: unknown[][] = [];
  const errorCalls: unknown[][] = [];
  return {
    warn: (...args: unknown[]) => { warnCalls.push(args); },
    error: (...args: unknown[]) => { errorCalls.push(args); },
    warnCalls,
    errorCalls,
  };
}

/** Create a test DomainEvent */
function testEvent(type = 'test.event') {
  return createEvent(type, { foo: 'bar' });
}

/** Create a minimal Redis mock for RedisEventTransport */
function createRedisMock(): RedisLike {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    psubscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    duplicate: vi.fn(function (this: RedisLike) { return createRedisMock(); }) as unknown as RedisLike['duplicate'],
    quit: vi.fn().mockResolvedValue(undefined),
    // Expose handlers for testing
    _handlers: handlers,
  } as unknown as RedisLike;
}

/** Create a minimal Redis Streams mock */
function createRedisStreamMock(): RedisStreamLike {
  return {
    xadd: vi.fn().mockResolvedValue('1-0'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xpending: vi.fn().mockResolvedValue([]),
    xclaim: vi.fn().mockResolvedValue([]),
    xlen: vi.fn().mockResolvedValue(0),
    quit: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// MemoryEventTransport
// ============================================================================

describe('MemoryEventTransport logger', () => {
  it('should use injected logger for handler errors', async () => {
    const logger = createMockLogger();
    const transport = new MemoryEventTransport({ logger });
    const handlerError = new Error('handler boom');

    await transport.subscribe('test.event', () => { throw handlerError; });
    await transport.publish(testEvent());

    expect(logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]![0]).toContain('[EventTransport] Handler error for test.event');
    expect(logger.errorCalls[0]![1]).toBe(handlerError);
  });

  it('should default to console when no logger is provided', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = new MemoryEventTransport();

    await transport.subscribe('test.event', () => { throw new Error('oops'); });
    await transport.publish(testEvent());

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0]![0]).toContain('[EventTransport] Handler error');
    consoleSpy.mockRestore();
  });

  it('should not call logger when handlers succeed', async () => {
    const logger = createMockLogger();
    const transport = new MemoryEventTransport({ logger });

    await transport.subscribe('test.event', () => {});
    await transport.publish(testEvent());

    expect(logger.errorCalls.length).toBe(0);
    expect(logger.warnCalls.length).toBe(0);
  });

  it('should log errors for each failing handler independently', async () => {
    const logger = createMockLogger();
    const transport = new MemoryEventTransport({ logger });
    const results: string[] = [];

    await transport.subscribe('test.event', () => { throw new Error('fail-1'); });
    await transport.subscribe('test.event', () => { results.push('ok'); });

    await transport.publish(testEvent());

    // One handler failed, one succeeded
    expect(logger.errorCalls.length).toBe(1);
    expect(results).toEqual(['ok']);
  });

  it('should still work after close (no logger calls on empty publish)', async () => {
    const logger = createMockLogger();
    const transport = new MemoryEventTransport({ logger });

    await transport.subscribe('test.event', () => { throw new Error('nope'); });
    await transport.close();
    await transport.publish(testEvent());

    // After close, handlers are cleared — no errors to log
    expect(logger.errorCalls.length).toBe(0);
  });
});

// ============================================================================
// withRetry
// ============================================================================

describe('withRetry logger', () => {
  it('should use injected logger for retry warnings', async () => {
    const logger = createMockLogger();
    let callCount = 0;

    const handler = withRetry(
      async () => {
        callCount++;
        if (callCount <= 2) throw new Error(`fail-${callCount}`);
      },
      { maxRetries: 3, backoffMs: 1, jitter: 0, logger, name: 'testHandler' },
    );

    await handler(testEvent());

    // 2 failures → 2 warn calls (retry warnings)
    expect(logger.warnCalls.length).toBe(2);
    expect(logger.warnCalls[0]![0]).toContain("Handler 'testHandler' failed for test.event");
    expect(logger.warnCalls[0]![0]).toContain('attempt 1/4');
    expect(logger.warnCalls[1]![0]).toContain('attempt 2/4');
    // No error call because it eventually succeeded
    expect(logger.errorCalls.length).toBe(0);
  });

  it('should use injected logger for permanent failure error', async () => {
    const logger = createMockLogger();

    const handler = withRetry(
      async () => { throw new Error('always fails'); },
      { maxRetries: 1, backoffMs: 1, jitter: 0, logger, name: 'deadHandler' },
    );

    await handler(testEvent());

    // 1 retry → 1 warn, then permanent failure → 1 error
    expect(logger.warnCalls.length).toBe(1);
    expect(logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]![0]).toContain("Handler 'deadHandler' permanently failed");
    expect(logger.errorCalls[0]![0]).toContain('after 2 attempts');
  });

  it('should use injected logger when onDead callback throws', async () => {
    const logger = createMockLogger();

    const handler = withRetry(
      async () => { throw new Error('fail'); },
      {
        maxRetries: 0,
        backoffMs: 1,
        jitter: 0,
        logger,
        onDead: async () => { throw new Error('dlq boom'); },
      },
    );

    await handler(testEvent());

    // 1 error for permanent failure + 1 error for DLQ callback failure
    expect(logger.errorCalls.length).toBe(2);
    expect(logger.errorCalls[1]![0]).toContain('Dead letter callback failed');
  });

  it('should default to console when no logger is provided', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const handler = withRetry(
      async () => { throw new Error('fail'); },
      { maxRetries: 1, backoffMs: 1, jitter: 0 },
    );

    await handler(testEvent());

    expect(warnSpy).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('should not log anything on immediate success', async () => {
    const logger = createMockLogger();

    const handler = withRetry(
      async () => { /* success */ },
      { logger },
    );

    await handler(testEvent());

    expect(logger.warnCalls.length).toBe(0);
    expect(logger.errorCalls.length).toBe(0);
  });
});

// ============================================================================
// RedisEventTransport
// ============================================================================

describe('RedisEventTransport logger', () => {
  it('should use injected logger for synchronous handler errors', async () => {
    const logger = createMockLogger();
    const redis = createRedisMock();
    const transport = new RedisEventTransport(redis, { logger });

    // Subscribe to trigger listener setup
    await transport.subscribe('test.*', () => {
      throw new Error('sync boom');
    });

    // Get the subscriber mock (duplicate)
    const sub = (redis.duplicate as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(sub).toBeDefined();

    // Simulate a pmessage from Redis
    const onCalls = (sub.on as ReturnType<typeof vi.fn>).mock.calls;
    const pmessageHandler = onCalls.find((c: unknown[]) => c[0] === 'pmessage')?.[1];
    expect(pmessageHandler).toBeDefined();

    const event = testEvent('test.created');
    const serialized = JSON.stringify(event, (_k, v) => v instanceof Date ? v.toISOString() : v);

    // Fire the message
    pmessageHandler('arc-events:test.*', 'arc-events:test.created', serialized);

    // The handler threw synchronously → logger.error should be called
    expect(logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]![0]).toContain('[RedisEventTransport] Handler error for test.created');

    await transport.close();
  });

  it('should use injected logger for async handler rejections', async () => {
    const logger = createMockLogger();
    const redis = createRedisMock();
    const transport = new RedisEventTransport(redis, { logger });

    await transport.subscribe('test.*', async () => {
      throw new Error('async boom');
    });

    const sub = (redis.duplicate as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const onCalls = (sub.on as ReturnType<typeof vi.fn>).mock.calls;
    const pmessageHandler = onCalls.find((c: unknown[]) => c[0] === 'pmessage')?.[1];

    const event = testEvent('test.created');
    const serialized = JSON.stringify(event, (_k, v) => v instanceof Date ? v.toISOString() : v);

    pmessageHandler('arc-events:test.*', 'arc-events:test.created', serialized);

    // Wait for async rejection to be caught
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]![0]).toContain('[RedisEventTransport] Handler error for test.created');

    await transport.close();
  });

  it('should default to console when no logger provided', () => {
    const redis = createRedisMock();
    // Should not throw — defaults to console
    const transport = new RedisEventTransport(redis);
    expect(transport.name).toBe('redis');
  });
});

// ============================================================================
// RedisStreamTransport
// ============================================================================

describe('RedisStreamTransport logger', () => {
  it('should accept logger option', () => {
    const logger = createMockLogger();
    const redis = createRedisStreamMock();
    const transport = new RedisStreamTransport(redis, { logger });
    expect(transport.name).toBe('redis-stream');
  });

  it('should default to console when no logger provided', () => {
    const redis = createRedisStreamMock();
    const transport = new RedisStreamTransport(redis);
    expect(transport.name).toBe('redis-stream');
  });

  it('should use injected logger for poll errors', async () => {
    const logger = createMockLogger();
    const redis = createRedisStreamMock();

    // Make xreadgroup throw on first call, then delay to let close() terminate cleanly
    let closing = false;
    (redis.xreadgroup as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('poll fail'))
      .mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, closing ? 0 : 20));
        return null;
      });

    const transport = new RedisStreamTransport(redis, {
      logger,
      blockTimeMs: 1,
    });

    // Subscribe starts the poll loop
    await transport.subscribe('*', async () => {});

    // Wait for the poll loop to encounter the error and log it
    await new Promise(resolve => setTimeout(resolve, 50));

    // Stop the poll loop
    closing = true;
    await transport.close();

    // The poll error should have been logged via our injected logger
    expect(logger.errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(logger.errorCalls[0]![0]).toContain('[RedisStreamTransport] Poll error:');
  });

  it('should use injected logger for handler errors during message processing', async () => {
    const logger = createMockLogger();
    const redis = createRedisStreamMock();

    // Simulate xreadgroup returning a message, then return null for subsequent reads
    const eventData = JSON.stringify({
      type: 'order.created',
      payload: { id: '123' },
      meta: { id: 'evt-1', timestamp: new Date().toISOString() },
    });

    // Use a flag to signal when close() was called so the mock can stop
    let closing = false;
    (redis.xreadgroup as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        ['arc:events', [['1-0', ['type', 'order.created', 'data', eventData]]]],
      ])
      .mockImplementation(async () => {
        // Delay to prevent tight spin, check closing flag
        await new Promise(resolve => setTimeout(resolve, closing ? 0 : 20));
        return null;
      });

    const transport = new RedisStreamTransport(redis, {
      logger,
      blockTimeMs: 1,
    });

    // Subscribe with a handler that throws
    await transport.subscribe('order.created', async () => {
      throw new Error('handler fail');
    });

    // Wait for the message to be processed
    await new Promise(resolve => setTimeout(resolve, 80));

    closing = true;
    await transport.close();

    // Handler error should have been logged
    const handlerErrorLogs = logger.errorCalls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('Handler error for order.created'),
    );
    expect(handlerErrorLogs.length).toBe(1);
  });
});

// ============================================================================
// EventLogger interface compatibility
// ============================================================================

describe('EventLogger interface compatibility', () => {
  it('should accept console as a logger (default behavior)', () => {
    // console satisfies EventLogger
    const logger: EventLogger = console;
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('should accept a pino-like object as logger', () => {
    // Pino loggers have warn/error methods
    const pinoLike: EventLogger = {
      warn: (_msg: string, ..._args: unknown[]) => {},
      error: (_msg: string, ..._args: unknown[]) => {},
    };
    const transport = new MemoryEventTransport({ logger: pinoLike });
    expect(transport.name).toBe('memory');
  });

  it('should accept a partial object with only warn and error', () => {
    const minimal: EventLogger = {
      warn: () => {},
      error: () => {},
    };
    const transport = new MemoryEventTransport({ logger: minimal });
    expect(transport.name).toBe('memory');
  });

  it('should work with MemoryEventTransport() no-arg constructor (backward compat)', () => {
    const transport = new MemoryEventTransport();
    expect(transport.name).toBe('memory');
  });
});
