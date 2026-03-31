/**
 * WebSocket Adapter — Cross-Instance Broadcast Tests
 *
 * Tests the pluggable adapter pattern for WebSocket room broadcasts
 * across multiple server instances.
 *
 * Without adapter: broadcast reaches only local clients (single-instance)
 * With adapter: broadcast goes through shared backplane (Redis pub/sub)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RoomManager,
  type WebSocketAdapter,
  LocalWebSocketAdapter,
} from '../../src/integrations/websocket.js';

// ============================================================================
// Mock adapter that simulates Redis pub/sub backplane
// ============================================================================

function createMockAdapter(): WebSocketAdapter & {
  published: Array<{ room: string; message: string }>;
  _deliver: (room: string, message: string) => void;
} {
  let subscriber: ((room: string, message: string) => void) | null = null;
  const published: Array<{ room: string; message: string }> = [];

  return {
    name: 'mock',
    published,

    async publish(room: string, message: string): Promise<void> {
      published.push({ room, message });
      // Simulate async delivery to other instances (not self — the publisher
      // already broadcast locally, so the adapter should only deliver to others)
    },

    async subscribe(callback: (room: string, message: string) => void): Promise<void> {
      subscriber = callback;
    },

    // Test helper: simulate message from another instance arriving via backplane
    _deliver(room: string, message: string) {
      subscriber?.(room, message);
    },

    async close(): Promise<void> {
      subscriber = null;
    },
  };
}

// ============================================================================
// WebSocketAdapter interface tests
// ============================================================================

describe('WebSocketAdapter — interface contract', () => {
  it('LocalWebSocketAdapter should be a no-op (single-instance)', async () => {
    const adapter = new LocalWebSocketAdapter();

    expect(adapter.name).toBe('local');

    // publish is a no-op
    await adapter.publish('room', 'message');

    // subscribe is a no-op
    await adapter.subscribe(() => {});

    // close is a no-op
    await adapter.close();
  });

  it('mock adapter should capture published messages', async () => {
    const adapter = createMockAdapter();

    await adapter.publish('products', JSON.stringify({ type: 'product.created' }));
    await adapter.publish('orders', JSON.stringify({ type: 'order.created' }));

    expect(adapter.published).toHaveLength(2);
    expect(adapter.published[0]!.room).toBe('products');
    expect(adapter.published[1]!.room).toBe('orders');
  });

  it('mock adapter should deliver messages to subscribers', async () => {
    const adapter = createMockAdapter();
    const received: Array<{ room: string; message: string }> = [];

    await adapter.subscribe((room, message) => {
      received.push({ room, message });
    });

    // Simulate message from another instance
    adapter._deliver('products', '{"type":"product.created"}');

    expect(received).toHaveLength(1);
    expect(received[0]!.room).toBe('products');
  });
});

// ============================================================================
// RoomManager + adapter integration
// ============================================================================

describe('RoomManager — adapter integration', () => {
  it('should broadcast locally AND through adapter when adapter is set', async () => {
    const adapter = createMockAdapter();
    const rooms = new RoomManager(10000, adapter);

    const socket1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    rooms.addClient({ id: 'ws_1', socket: socket1, subscriptions: new Set(), userId: 'u1' });
    rooms.subscribe('ws_1', 'products');

    await rooms.broadcastWithAdapter('products', '{"type":"test"}');

    // Local client received the message
    expect(socket1.send).toHaveBeenCalledWith('{"type":"test"}');

    // Adapter also received the message (for other instances)
    expect(adapter.published).toHaveLength(1);
    expect(adapter.published[0]!.room).toBe('products');
  });

  it('should deliver adapter messages to local clients', async () => {
    const adapter = createMockAdapter();
    const rooms = new RoomManager(10000, adapter);

    // Wire adapter subscription to local broadcast
    await adapter.subscribe((room, message) => {
      rooms.broadcast(room, message);
    });

    const socket1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    rooms.addClient({ id: 'ws_1', socket: socket1, subscriptions: new Set(), userId: 'u1' });
    rooms.subscribe('ws_1', 'products');

    // Simulate message from another instance via adapter
    adapter._deliver('products', '{"type":"product.updated"}');

    expect(socket1.send).toHaveBeenCalledWith('{"type":"product.updated"}');
  });

  it('should NOT double-deliver to local clients on broadcastWithAdapter', async () => {
    const adapter = createMockAdapter();
    const rooms = new RoomManager(10000, adapter);

    const socket1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    rooms.addClient({ id: 'ws_1', socket: socket1, subscriptions: new Set() });
    rooms.subscribe('ws_1', 'products');

    // broadcastWithAdapter sends locally + to adapter
    // The adapter should NOT echo back to the same instance
    await rooms.broadcastWithAdapter('products', '{"type":"test"}');

    // Local client should receive exactly once (from local broadcast, not from adapter echo)
    expect(socket1.send).toHaveBeenCalledTimes(1);
  });

  it('should work without adapter (local-only, default behavior)', () => {
    const rooms = new RoomManager(); // no adapter

    const socket1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    rooms.addClient({ id: 'ws_1', socket: socket1, subscriptions: new Set() });
    rooms.subscribe('ws_1', 'products');

    rooms.broadcast('products', '{"type":"test"}');

    expect(socket1.send).toHaveBeenCalledWith('{"type":"test"}');
  });

  it('broadcastToOrg should also go through adapter', async () => {
    const adapter = createMockAdapter();
    const rooms = new RoomManager(10000, adapter);

    const socket1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    rooms.addClient({ id: 'ws_1', socket: socket1, subscriptions: new Set(), organizationId: 'org-1' });
    rooms.subscribe('ws_1', 'orders');

    await rooms.broadcastToOrgWithAdapter('org-1', 'orders', '{"type":"order.created"}');

    expect(socket1.send).toHaveBeenCalledOnce();
    expect(adapter.published).toHaveLength(1);
    expect(adapter.published[0]!.room).toBe('org:org-1:orders');
  });
});
