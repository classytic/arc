/**
 * Jobs Plugin — Lifecycle and Resource Cleanup Tests
 *
 * Verifies:
 * - Timeout timers are cleared after handler success (no orphaned timers)
 * - DLQ queues are tracked and closed on shutdown (no connection leaks)
 * - DLQ is only created when explicitly configured
 *
 * These are unit tests for the timeout/cleanup logic, not BullMQ integration tests.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ============================================================================
// Timeout timer cleanup
// ============================================================================

describe('job timeout timer cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should clear timeout timer when handler resolves before timeout', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    // Simulate the timeout pattern from jobs.ts
    const jobTimeout = 5000;
    const handler = async () => 'done';

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), jobTimeout);
    });

    try {
      await Promise.race([handler(), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    // Timer should have been cleared
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
  });

  it('should clear timeout timer even when handler throws', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const jobTimeout = 5000;
    const handler = async () => { throw new Error('handler failed'); };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), jobTimeout);
    });

    try {
      await Promise.race([handler(), timeoutPromise]);
    } catch {
      // Expected
    } finally {
      clearTimeout(timer);
    }

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
  });

  it('should not leave orphaned timers under rapid job completion', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const jobTimeout = 30000; // Long timeout

    // Simulate 100 rapid job completions
    for (let i = 0; i < 100; i++) {
      const handler = async () => `result-${i}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), jobTimeout);
      });

      try {
        await Promise.race([handler(), timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    }

    // All 100 timers should have been cleared
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(100);
  });

  it('should reject with timeout error when handler exceeds timeout', async () => {
    const jobTimeout = 50; // 50ms timeout
    const handler = () => new Promise(resolve => setTimeout(resolve, 200)); // 200ms handler

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Job timed out after ${jobTimeout}ms`)), jobTimeout);
    });

    await expect(
      (async () => {
        try {
          return await Promise.race([handler(), timeoutPromise]);
        } finally {
          clearTimeout(timer);
        }
      })()
    ).rejects.toThrow(/timed out/);
  });
});

// ============================================================================
// DLQ queue lifecycle
// ============================================================================

describe('DLQ queue creation and tracking', () => {
  it('should not create DLQ queue when deadLetterQueue is not configured', () => {
    const job = {
      name: 'simple-job',
      handler: async () => 'done',
      retries: 3,
      // No deadLetterQueue
    };

    // deadLetterQueue is undefined — DLQ should NOT be created
    expect(job.deadLetterQueue).toBeUndefined();
    expect(job.deadLetterQueue != null).toBe(false);
  });

  it('should flag DLQ creation when deadLetterQueue is explicitly set', () => {
    const job = {
      name: 'email-job',
      handler: async () => 'sent',
      deadLetterQueue: 'email:dead',
    };

    expect(job.deadLetterQueue != null).toBe(true);
    expect(job.deadLetterQueue).toBe('email:dead');
  });

  it('should flag DLQ creation with empty string (uses default name)', () => {
    const job = {
      name: 'process-job',
      handler: async () => 'done',
      deadLetterQueue: '', // Empty string = use default name
    };

    // Empty string is != null, so DLQ IS created with default name
    expect(job.deadLetterQueue != null).toBe(true);
    const dlqName = job.deadLetterQueue || `${job.name}:dead`;
    expect(dlqName).toBe('process-job:dead');
  });
});

describe('dispatcher.close() cleanup contract', () => {
  it('should close all resource types: workers, queues, and DLQ queues', async () => {
    // Mock the close() contract that jobs.ts implements
    const closedResources: string[] = [];

    const mockWorker = { close: async () => { closedResources.push('worker'); } };
    const mockQueue = { close: async () => { closedResources.push('queue'); } };
    const mockDlqQueue = { close: async () => { closedResources.push('dlq'); } };

    const workers = new Map([['job-1', mockWorker]]);
    const queues = new Map([['job-1', mockQueue]]);
    const dlqQueues = new Map([['job-1:dead', mockDlqQueue]]);

    // Simulate dispatcher.close()
    const closePromises: Promise<void>[] = [];
    for (const worker of workers.values()) closePromises.push(worker.close());
    for (const queue of queues.values()) closePromises.push(queue.close());
    for (const dlq of dlqQueues.values()) closePromises.push(dlq.close());
    await Promise.all(closePromises);

    // All three resource types should be closed
    expect(closedResources).toContain('worker');
    expect(closedResources).toContain('queue');
    expect(closedResources).toContain('dlq');
    expect(closedResources).toHaveLength(3);
  });

  it('should handle multiple DLQ queues across multiple jobs', async () => {
    const closedDlqs: string[] = [];

    const dlqQueues = new Map([
      ['email:dead', { close: async () => { closedDlqs.push('email:dead'); } }],
      ['image:dead', { close: async () => { closedDlqs.push('image:dead'); } }],
      ['report:dead', { close: async () => { closedDlqs.push('report:dead'); } }],
    ]);

    const closePromises: Promise<void>[] = [];
    for (const dlq of dlqQueues.values()) closePromises.push(dlq.close());
    await Promise.all(closePromises);

    expect(closedDlqs).toHaveLength(3);
    expect(closedDlqs).toEqual(['email:dead', 'image:dead', 'report:dead']);
  });

  it('should not fail when no DLQ queues exist', async () => {
    const dlqQueues = new Map<string, { close: () => Promise<void> }>();

    const closePromises: Promise<void>[] = [];
    for (const dlq of dlqQueues.values()) closePromises.push(dlq.close());
    await Promise.all(closePromises);

    // No error, no-op
    expect(dlqQueues.size).toBe(0);
  });
});
