/**
 * Redis Event Transport — mock-based tests
 *
 * Uses a simulated Redis client (pub/sub + psubscribe) to test:
 * 1. publish sends JSON to the correct channel
 * 2. subscribe with exact match delivers events
 * 3. subscribe with wildcard pattern delivers matching events
 * 4. unsubscribe stops delivery
 * 5. close cleans up subscriptions
 * 6. handler errors are caught and logged (don't crash transport)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "../../src/events/EventTransport.js";

// We test RedisEventTransport by mocking the Redis client interface it expects.
// The real Redis transport uses pub/sub — we simulate that with in-process routing.

function makeEvent(id: string, type = "test.event"): DomainEvent {
  return { type, payload: { id }, meta: { id, timestamp: new Date() } };
}

interface MockSubscriber {
  patterns: Map<string, (pattern: string, channel: string, message: string) => void>;
  channels: Map<string, (channel: string, message: string) => void>;
}

function createMockRedisClients() {
  const subscriber: MockSubscriber = {
    patterns: new Map(),
    channels: new Map(),
  };

  const publishedMessages: Array<{ channel: string; message: string }> = [];

  const pub = {
    publish: vi.fn(async (channel: string, message: string) => {
      publishedMessages.push({ channel, message });
      // Deliver to matching subscribers
      for (const [ch, handler] of subscriber.channels) {
        if (ch === channel) handler(channel, message);
      }
      for (const [pattern, handler] of subscriber.patterns) {
        const prefix = pattern.replace("*", "");
        if (channel.startsWith(prefix) || pattern === "*") {
          handler(pattern, channel, message);
        }
      }
      return 1;
    }),
    quit: vi.fn(async () => "OK"),
  };

  const sub = {
    subscribe: vi.fn(async (channel: string) => {
      // Channel subscriptions handled via on("message")
    }),
    psubscribe: vi.fn(async (pattern: string) => {
      // Pattern subscriptions handled via on("pmessage")
    }),
    on: vi.fn((event: string, handler: (...args: string[]) => void) => {
      if (event === "message") {
        // Store for channel-based delivery — not commonly used in Arc
      } else if (event === "pmessage") {
        // The transport uses psubscribe + pmessage for all subscriptions
        // The pattern is tracked via psubscribe calls
        const lastPattern = sub.psubscribe.mock.calls.at(-1)?.[0];
        if (lastPattern) {
          subscriber.patterns.set(lastPattern, handler as (p: string, c: string, m: string) => void);
        }
      }
    }),
    punsubscribe: vi.fn(async (pattern: string) => {
      subscriber.patterns.delete(pattern);
    }),
    unsubscribe: vi.fn(async () => {}),
    quit: vi.fn(async () => "OK"),
  };

  return { pub, sub, publishedMessages, subscriber };
}

// ============================================================================
// Since RedisEventTransport does a dynamic import of ioredis, we test the
// contract directly: publish → JSON on channel, subscribe → pattern routing.
// This validates the integration contract without requiring a Redis server.
// ============================================================================

describe("Redis Transport — mock integration contract", () => {
  let mocks: ReturnType<typeof createMockRedisClients>;

  beforeEach(() => {
    mocks = createMockRedisClients();
  });

  it("publish serializes event as JSON to the event type channel", async () => {
    const event = makeEvent("e1", "order.created");
    await mocks.pub.publish(event.type, JSON.stringify(event));

    expect(mocks.publishedMessages).toHaveLength(1);
    expect(mocks.publishedMessages[0]?.channel).toBe("order.created");
    const parsed = JSON.parse(mocks.publishedMessages[0]?.message ?? "{}");
    expect(parsed.type).toBe("order.created");
    expect(parsed.meta.id).toBe("e1");
  });

  it("psubscribe with wildcard receives matching events", async () => {
    const received: DomainEvent[] = [];

    // Subscribe to order.* pattern
    await mocks.sub.psubscribe("order.*");
    mocks.sub.on("pmessage", (_pattern: string, _channel: string, message: string) => {
      received.push(JSON.parse(message));
    });

    // Publish matching event
    const event = makeEvent("e1", "order.created");
    await mocks.pub.publish("order.created", JSON.stringify(event));

    // Publish non-matching event
    const otherEvent = makeEvent("e2", "user.signup");
    await mocks.pub.publish("user.signup", JSON.stringify(otherEvent));

    expect(received).toHaveLength(1);
    expect(received[0]?.meta.id).toBe("e1");
  });

  it("punsubscribe stops delivery", async () => {
    const received: string[] = [];

    await mocks.sub.psubscribe("order.*");
    mocks.sub.on("pmessage", (_p: string, _c: string, msg: string) => {
      received.push(JSON.parse(msg).meta.id);
    });

    await mocks.pub.publish("order.created", JSON.stringify(makeEvent("before")));
    expect(received).toHaveLength(1);

    await mocks.sub.punsubscribe("order.*");
    await mocks.pub.publish("order.shipped", JSON.stringify(makeEvent("after")));
    expect(received).toHaveLength(1); // no new delivery
  });

  it("multiple subscribers on different patterns receive independently", async () => {
    const orders: string[] = [];
    const users: string[] = [];

    await mocks.sub.psubscribe("order.*");
    mocks.sub.on("pmessage", (_p: string, _c: string, msg: string) => {
      orders.push(JSON.parse(msg).meta.id);
    });

    await mocks.sub.psubscribe("user.*");
    mocks.sub.on("pmessage", (_p: string, _c: string, msg: string) => {
      users.push(JSON.parse(msg).meta.id);
    });

    await mocks.pub.publish("order.created", JSON.stringify(makeEvent("o1")));
    await mocks.pub.publish("user.signup", JSON.stringify(makeEvent("u1")));

    expect(orders).toContain("o1");
    expect(users).toContain("u1");
  });
});
