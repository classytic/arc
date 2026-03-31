/**
 * Webhook Plugin — Enterprise Integration Tests
 *
 * Covers: plugin lifecycle, subscription CRUD, event auto-dispatch,
 * pattern matching, HMAC signing, delivery logging, store contract,
 * multi-subscriber fan-out, error isolation, payload fidelity,
 * ring buffer overflow, timeout handling, and cleanup.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ============================================================================
// Helpers — reduce boilerplate per TDD data-factories pattern
// ============================================================================

async function createWebhookApp(
  fetchMock?: ReturnType<typeof vi.fn>,
  pluginOpts?: Record<string, unknown>,
) {
  const { webhookPlugin } = await import('../../src/integrations/webhooks.js');
  const { eventPlugin } = await import('../../src/events/eventPlugin.js');

  const app = Fastify({ logger: false });
  await app.register(eventPlugin);
  await app.register(webhookPlugin, {
    fetch: fetchMock ?? vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    ...pluginOpts,
  });
  await app.ready();
  return app;
}

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200 });
}

function failFetch(error = 'Connection refused') {
  return vi.fn().mockRejectedValue(new Error(error));
}

function httpErrorFetch(status = 500) {
  return vi.fn().mockResolvedValue({ ok: false, status });
}

/** Wait for async dispatch via vi.waitFor — no magic setTimeout */
async function waitForDelivery(
  app: FastifyInstance,
  expectedCount: number,
  timeoutMs = 500,
) {
  await vi.waitFor(
    () => {
      const count = app.webhooks.deliveryLog().length;
      if (count < expectedCount) throw new Error(`Expected ${expectedCount} deliveries, got ${count}`);
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

describe('Webhook Plugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close().catch(() => {});
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Plugin lifecycle
  // ==========================================================================

  describe('plugin lifecycle', () => {
    it('decorates fastify.webhooks with register/unregister/list/deliveryLog', async () => {
      app = await createWebhookApp();

      expect(app.webhooks).toBeDefined();
      expect(typeof app.webhooks.register).toBe('function');
      expect(typeof app.webhooks.unregister).toBe('function');
      expect(typeof app.webhooks.list).toBe('function');
      expect(typeof app.webhooks.deliveryLog).toBe('function');
    });

    it('starts with empty subscriptions when no store provided', async () => {
      app = await createWebhookApp();
      expect(app.webhooks.list()).toHaveLength(0);
    });

    it('starts with empty delivery log', async () => {
      app = await createWebhookApp();
      expect(app.webhooks.deliveryLog()).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Subscription CRUD
  // ==========================================================================

  describe('subscription CRUD', () => {
    it('register → list returns the subscription', async () => {
      app = await createWebhookApp();

      await app.webhooks.register({
        id: 'wh-1',
        url: 'https://example.com/hook',
        events: ['order.created'],
        secret: 'sec-123',
      });

      const subs = app.webhooks.list();
      expect(subs).toHaveLength(1);
      expect(subs[0]).toEqual(expect.objectContaining({
        id: 'wh-1',
        url: 'https://example.com/hook',
        events: ['order.created'],
      }));
    });

    it('unregister → list no longer returns it', async () => {
      app = await createWebhookApp();

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's',
      });
      await app.webhooks.unregister('wh-1');

      expect(app.webhooks.list()).toHaveLength(0);
    });

    it('re-register with same ID replaces the subscription', async () => {
      app = await createWebhookApp();

      await app.webhooks.register({
        id: 'wh-1', url: 'https://old.com', events: ['a'], secret: 's1',
      });
      await app.webhooks.register({
        id: 'wh-1', url: 'https://new.com', events: ['b'], secret: 's2',
      });

      const subs = app.webhooks.list();
      expect(subs).toHaveLength(1);
      expect(subs[0].url).toBe('https://new.com');
      expect(subs[0].events).toEqual(['b']);
    });

    it('unregister non-existent ID is a no-op', async () => {
      app = await createWebhookApp();
      // Should not throw
      await app.webhooks.unregister('does-not-exist');
      expect(app.webhooks.list()).toHaveLength(0);
    });

    it('list returns a copy — mutations do not affect internal state', async () => {
      app = await createWebhookApp();

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's',
      });

      const subs = app.webhooks.list();
      subs.length = 0; // mutate the returned array

      expect(app.webhooks.list()).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Event auto-dispatch
  // ==========================================================================

  describe('event auto-dispatch', () => {
    it('delivers to matching subscriber when Arc event fires', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1',
        url: 'https://customer.com/hook',
        events: ['order.created'],
        secret: 'whsec_test',
      });

      await app.events.publish('order.created', { orderId: '123', total: 99 });
      await waitForDelivery(app, 1);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://customer.com/hook');
      expect(opts.method).toBe('POST');
    });

    it('does NOT deliver to non-matching subscriber', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['order.created'], secret: 's',
      });

      await app.events.publish('product.updated', { name: 'Widget' });

      // Give it time to potentially fire (should not)
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fans out to multiple matching subscribers', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['order.*'], secret: 's1',
      });
      await app.webhooks.register({
        id: 'wh-2', url: 'https://b.com', events: ['order.created'], secret: 's2',
      });
      await app.webhooks.register({
        id: 'wh-3', url: 'https://c.com', events: ['product.*'], secret: 's3',
      });

      await app.events.publish('order.created', { id: '1' });
      await waitForDelivery(app, 2);

      // wh-1 (order.*) and wh-2 (order.created) match. wh-3 does not.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0]);
      expect(urls).toContain('https://a.com');
      expect(urls).toContain('https://b.com');
      expect(urls).not.toContain('https://c.com');
    });

    it('one subscriber failure does NOT block delivery to others', async () => {
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (url === 'https://bad.com') return Promise.reject(new Error('down'));
        return Promise.resolve({ ok: true, status: 200 });
      });

      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-bad', url: 'https://bad.com', events: ['test.*'], secret: 's',
      });
      await app.webhooks.register({
        id: 'wh-good', url: 'https://good.com', events: ['test.*'], secret: 's',
      });

      await app.events.publish('test.event', {});
      await waitForDelivery(app, 2);

      // Both were attempted
      expect(callCount).toBe(2);

      const log = app.webhooks.deliveryLog();
      const bad = log.find((l) => l.subscriptionId === 'wh-bad');
      const good = log.find((l) => l.subscriptionId === 'wh-good');
      expect(bad!.success).toBe(false);
      expect(good!.success).toBe(true);
    });
  });

  // ==========================================================================
  // Pattern matching
  // ==========================================================================

  describe('pattern matching', () => {
    it('matches exact event type', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['order.created'], secret: 's',
      });

      await app.events.publish('order.created', {});
      await waitForDelivery(app, 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('matches prefix wildcard (order.*)', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['order.*'], secret: 's',
      });

      await app.events.publish('order.shipped', {});
      await waitForDelivery(app, 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('matches global wildcard (*)', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's',
      });

      await app.events.publish('anything.here', {});
      await waitForDelivery(app, 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT match wrong prefix (order.* should not match product.created)', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['order.*'], secret: 's',
      });

      await app.events.publish('product.created', {});
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('supports multiple patterns on one subscription', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['order.created', 'invoice.sent'], secret: 's',
      });

      await app.events.publish('invoice.sent', {});
      await waitForDelivery(app, 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // HMAC signing — payload fidelity
  // ==========================================================================

  describe('HMAC signing', () => {
    it('produces sha256= prefixed hex signature', async () => {
      const { signPayload } = await import('../../src/integrations/webhooks.js');
      const sig = signPayload('{"test":true}', 'my-secret');
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('is deterministic for same payload + secret', async () => {
      const { signPayload } = await import('../../src/integrations/webhooks.js');
      expect(signPayload('hello', 'sec')).toBe(signPayload('hello', 'sec'));
    });

    it('differs when secret changes', async () => {
      const { signPayload } = await import('../../src/integrations/webhooks.js');
      expect(signPayload('hello', 'a')).not.toBe(signPayload('hello', 'b'));
    });

    it('differs when payload changes', async () => {
      const { signPayload } = await import('../../src/integrations/webhooks.js');
      expect(signPayload('a', 'sec')).not.toBe(signPayload('b', 'sec'));
    });

    it('sends correct headers with each delivery', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['test.fire'], secret: 'whsec_abc',
      });

      await app.events.publish('test.fire', { key: 'value' });
      await waitForDelivery(app, 1);

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-webhook-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(headers['x-webhook-event']).toBe('test.fire');
      expect(headers['x-webhook-id']).toBeDefined();
    });

    it('each subscriber gets signature from its own secret', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['e'], secret: 'secret-A',
      });
      await app.webhooks.register({
        id: 'wh-2', url: 'https://b.com', events: ['e'], secret: 'secret-B',
      });

      await app.events.publish('e', {});
      await waitForDelivery(app, 2);

      const sig1 = fetchMock.mock.calls[0][1].headers['x-webhook-signature'];
      const sig2 = fetchMock.mock.calls[1][1].headers['x-webhook-signature'];
      expect(sig1).not.toBe(sig2);
    });
  });

  // ==========================================================================
  // Payload fidelity
  // ==========================================================================

  describe('payload fidelity', () => {
    it('delivers event type, payload, and meta in JSON body', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['order.created'], secret: 's',
      });

      await app.events.publish('order.created', { orderId: '42', total: 100 });
      await waitForDelivery(app, 1);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe('order.created');
      expect(body.payload).toEqual({ orderId: '42', total: 100 });
      expect(body.meta).toBeDefined();
      expect(body.meta.id).toBeDefined();
      expect(body.meta.timestamp).toBeDefined();
    });
  });

  // ==========================================================================
  // Delivery log
  // ==========================================================================

  describe('delivery log', () => {
    it('records successful delivery with status and event type', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['test.ok'], secret: 's',
      });

      await app.events.publish('test.ok', {});
      await waitForDelivery(app, 1);

      const log = app.webhooks.deliveryLog();
      expect(log).toHaveLength(1);
      expect(log[0]).toEqual(expect.objectContaining({
        subscriptionId: 'wh-1',
        eventType: 'test.ok',
        success: true,
        status: 200,
      }));
      expect(log[0].timestamp).toBeInstanceOf(Date);
    });

    it('records failed delivery with error message', async () => {
      app = await createWebhookApp(failFetch('ECONNREFUSED'));

      await app.webhooks.register({
        id: 'wh-1', url: 'https://down.com', events: ['test.fail'], secret: 's',
      });

      await app.events.publish('test.fail', {});
      await waitForDelivery(app, 1);

      const log = app.webhooks.deliveryLog();
      expect(log).toHaveLength(1);
      expect(log[0].success).toBe(false);
      expect(log[0].error).toBe('ECONNREFUSED');
      expect(log[0].status).toBeUndefined();
    });

    it('records HTTP error status (non-2xx) as failure', async () => {
      app = await createWebhookApp(httpErrorFetch(502));

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['test.http'], secret: 's',
      });

      await app.events.publish('test.http', {});
      await waitForDelivery(app, 1);

      const log = app.webhooks.deliveryLog();
      expect(log[0].success).toBe(false);
      expect(log[0].status).toBe(502);
    });

    it('deliveryLog(limit) returns only last N entries', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's',
      });

      for (let i = 0; i < 5; i++) {
        await app.events.publish(`event.${i}`, {});
      }
      await waitForDelivery(app, 5);

      const last2 = app.webhooks.deliveryLog(2);
      expect(last2).toHaveLength(2);
      expect(last2[0].eventType).toBe('event.3');
      expect(last2[1].eventType).toBe('event.4');
    });

    it('ring buffer caps at maxLogEntries', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock, { maxLogEntries: 3 });

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's',
      });

      for (let i = 0; i < 10; i++) {
        await app.events.publish(`evt.${i}`, {});
      }
      await waitForDelivery(app, 3); // can only hold 3

      const log = app.webhooks.deliveryLog();
      expect(log.length).toBeLessThanOrEqual(3);
    });
  });

  // ==========================================================================
  // WebhookStore contract
  // ==========================================================================

  describe('WebhookStore contract', () => {
    it('loads subscriptions from store on plugin init', async () => {
      const { webhookPlugin } = await import('../../src/integrations/webhooks.js');
      const { eventPlugin } = await import('../../src/events/eventPlugin.js');

      const customStore = {
        name: 'postgres',
        getAll: vi.fn().mockResolvedValue([
          { id: 'db-1', url: 'https://stored.com', events: ['*'], secret: 'sec' },
          { id: 'db-2', url: 'https://other.com', events: ['order.*'], secret: 'sec2' },
        ]),
        save: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(webhookPlugin, { store: customStore });
      await app.ready();

      expect(customStore.getAll).toHaveBeenCalledOnce();
      expect(app.webhooks.list()).toHaveLength(2);
    });

    it('persists new subscription to store on register', async () => {
      const { webhookPlugin } = await import('../../src/integrations/webhooks.js');
      const { eventPlugin } = await import('../../src/events/eventPlugin.js');

      const customStore = {
        name: 'mongo',
        getAll: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(webhookPlugin, { store: customStore });
      await app.ready();

      await app.webhooks.register({
        id: 'wh-new', url: 'https://new.com', events: ['a'], secret: 's',
      });

      expect(customStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wh-new', url: 'https://new.com' }),
      );
    });

    it('removes subscription from store on unregister', async () => {
      const { webhookPlugin } = await import('../../src/integrations/webhooks.js');
      const { eventPlugin } = await import('../../src/events/eventPlugin.js');

      const customStore = {
        name: 'redis',
        getAll: vi.fn().mockResolvedValue([
          { id: 'wh-del', url: 'https://a.com', events: ['*'], secret: 's' },
        ]),
        save: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(webhookPlugin, { store: customStore });
      await app.ready();

      await app.webhooks.unregister('wh-del');

      expect(customStore.remove).toHaveBeenCalledWith('wh-del');
      expect(app.webhooks.list()).toHaveLength(0);
    });

    it('store-loaded subscriptions receive event dispatches', async () => {
      const { webhookPlugin } = await import('../../src/integrations/webhooks.js');
      const { eventPlugin } = await import('../../src/events/eventPlugin.js');

      const fetchMock = okFetch();
      const customStore = {
        name: 'test',
        getAll: vi.fn().mockResolvedValue([
          { id: 'preloaded', url: 'https://preloaded.com', events: ['ping'], secret: 'sec' },
        ]),
        save: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(webhookPlugin, { store: customStore, fetch: fetchMock });
      await app.ready();

      await app.events.publish('ping', { ts: Date.now() });
      await waitForDelivery(app, 1);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://preloaded.com');
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('no crash when event fires with zero subscribers', async () => {
      app = await createWebhookApp();

      // Should not throw
      await app.events.publish('lonely.event', {});
      await new Promise((r) => setTimeout(r, 30));

      expect(app.webhooks.deliveryLog()).toHaveLength(0);
    });

    it('dynamically registered webhook receives subsequent events', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      // Publish before register — should not deliver
      await app.events.publish('test.before', {});
      await new Promise((r) => setTimeout(r, 30));
      expect(fetchMock).not.toHaveBeenCalled();

      // Register webhook
      await app.webhooks.register({
        id: 'wh-late', url: 'https://late.com', events: ['test.*'], secret: 's',
      });

      // Publish after register — should deliver
      await app.events.publish('test.after', {});
      await waitForDelivery(app, 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('unregistered webhook stops receiving events', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-temp', url: 'https://temp.com', events: ['*'], secret: 's',
      });

      await app.events.publish('first', {});
      await waitForDelivery(app, 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await app.webhooks.unregister('wh-temp');

      await app.events.publish('second', {});
      await new Promise((r) => setTimeout(r, 50));
      // Still 1 — second event should NOT be delivered
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Timeout handling
  // ==========================================================================

  describe('timeout handling', () => {
    it('records error when delivery times out', async () => {
      // Fetch that never resolves — will be aborted by AbortController
      const hangingFetch = vi.fn().mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      );

      app = await createWebhookApp(hangingFetch, { timeout: 50 });

      await app.webhooks.register({
        id: 'wh-slow', url: 'https://slow.com', events: ['t'], secret: 's',
      });

      await app.events.publish('t', {});
      await waitForDelivery(app, 1);

      const log = app.webhooks.deliveryLog();
      expect(log).toHaveLength(1);
      expect(log[0].success).toBe(false);
      expect(log[0].error).toContain('abort');
    });
  });

  // ==========================================================================
  // Store error resilience
  // ==========================================================================

  describe('store error resilience', () => {
    it('register propagates store.save() errors to caller', async () => {
      const { webhookPlugin } = await import('../../src/integrations/webhooks.js');
      const { eventPlugin } = await import('../../src/events/eventPlugin.js');

      const brokenStore = {
        name: 'broken',
        getAll: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockRejectedValue(new Error('DB write failed')),
        remove: vi.fn().mockResolvedValue(undefined),
      };

      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(webhookPlugin, { store: brokenStore });
      await app.ready();

      await expect(
        app.webhooks.register({ id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's' }),
      ).rejects.toThrow('DB write failed');
    });

    it('unregister propagates store.remove() errors to caller', async () => {
      const { webhookPlugin } = await import('../../src/integrations/webhooks.js');
      const { eventPlugin } = await import('../../src/events/eventPlugin.js');

      const brokenStore = {
        name: 'broken',
        getAll: vi.fn().mockResolvedValue([
          { id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's' },
        ]),
        save: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockRejectedValue(new Error('DB delete failed')),
      };

      app = Fastify({ logger: false });
      await app.register(eventPlugin);
      await app.register(webhookPlugin, { store: brokenStore });
      await app.ready();

      await expect(app.webhooks.unregister('wh-1')).rejects.toThrow('DB delete failed');
    });
  });

  // ==========================================================================
  // Ring buffer boundary precision
  // ==========================================================================

  describe('ring buffer boundary', () => {
    it('keeps exactly maxLogEntries after overflow', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock, { maxLogEntries: 3 });

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's',
      });

      // Publish exactly 5 events — buffer should keep last 3
      for (let i = 0; i < 5; i++) {
        await app.events.publish(`e.${i}`, {});
      }
      await waitForDelivery(app, 3);

      // Wait for all 5 to complete processing
      await new Promise((r) => setTimeout(r, 100));

      const log = app.webhooks.deliveryLog();
      expect(log).toHaveLength(3);
      // Should be the LAST 3 events
      expect(log[0].eventType).toBe('e.2');
      expect(log[1].eventType).toBe('e.3');
      expect(log[2].eventType).toBe('e.4');
    });

    it('does not splice when at exact capacity', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock, { maxLogEntries: 3 });

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's',
      });

      // Publish exactly 3 — should fill to capacity, no splice
      for (let i = 0; i < 3; i++) {
        await app.events.publish(`e.${i}`, {});
      }
      await waitForDelivery(app, 3);

      const log = app.webhooks.deliveryLog();
      expect(log).toHaveLength(3);
      expect(log[0].eventType).toBe('e.0');
    });
  });

  // ==========================================================================
  // Delivery log mutation safety
  // ==========================================================================

  describe('delivery log mutation safety', () => {
    it('mutating deliveryLog() result does not affect internal state', async () => {
      const fetchMock = okFetch();
      app = await createWebhookApp(fetchMock);

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['*'], secret: 's',
      });

      await app.events.publish('test', {});
      await waitForDelivery(app, 1);

      const logCopy = app.webhooks.deliveryLog();
      logCopy.length = 0; // mutate returned array

      // Internal state should be unaffected
      expect(app.webhooks.deliveryLog()).toHaveLength(1);
    });
  });

  // ==========================================================================
  // HTTP error statuses
  // ==========================================================================

  describe('HTTP error statuses', () => {
    it('records 404 as failure', async () => {
      app = await createWebhookApp(httpErrorFetch(404));

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['e'], secret: 's',
      });

      await app.events.publish('e', {});
      await waitForDelivery(app, 1);

      const log = app.webhooks.deliveryLog();
      expect(log[0].success).toBe(false);
      expect(log[0].status).toBe(404);
    });

    it('records 500 as failure', async () => {
      app = await createWebhookApp(httpErrorFetch(500));

      await app.webhooks.register({
        id: 'wh-1', url: 'https://a.com', events: ['e'], secret: 's',
      });

      await app.events.publish('e', {});
      await waitForDelivery(app, 1);

      const log = app.webhooks.deliveryLog();
      expect(log[0].success).toBe(false);
      expect(log[0].status).toBe(500);
    });
  });
});
