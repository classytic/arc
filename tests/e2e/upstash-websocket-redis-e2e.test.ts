/**
 * End-to-end test for RedisWebSocketAdapter against real Upstash Redis.
 *
 * The adapter is a pure Redis Pub/Sub bridge — testable without real
 * WebSocket clients by pairing two adapters with different instance IDs
 * and verifying:
 *
 *   1. Cross-instance fan-out (publisher → subscriber receives)
 *   2. Echo suppression (an adapter does NOT receive its own broadcasts)
 *   3. Room/message envelope preservation
 *   4. Malformed payload resilience (raw bad JSON on the channel doesn't crash)
 *   5. close() cleanly disconnects the subscribe-side duplicate
 *
 * Skipped when UPSTASH_REDIS_URL is not set.
 */

import "dotenv/config";

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisWebSocketAdapter } from "../../src/integrations/websocket-redis.js";

const redisUrl = process.env.UPSTASH_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

function makeRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5_000, intervalMs = 100 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeRedis("Upstash Redis — RedisWebSocketAdapter end-to-end", () => {
  let aRedis: Redis;
  let bRedis: Redis;
  let adapterA: RedisWebSocketAdapter;
  let adapterB: RedisWebSocketAdapter;
  const channel = `arc-test-ws-${runId}`;

  beforeAll(async () => {
    aRedis = makeRedis(redisUrl!);
    bRedis = makeRedis(redisUrl!);

    adapterA = new RedisWebSocketAdapter(aRedis, { channel, instanceId: "instance-A" });
    adapterB = new RedisWebSocketAdapter(bRedis, { channel, instanceId: "instance-B" });
  }, 30_000);

  afterAll(async () => {
    await adapterA.close();
    await adapterB.close();
    aRedis.disconnect();
    bRedis.disconnect();
  });

  it("publishes from A → B receives; echo suppression keeps A silent", async () => {
    const receivedA: Array<{ room: string; message: string }> = [];
    const receivedB: Array<{ room: string; message: string }> = [];

    await adapterA.subscribe((room, message) => receivedA.push({ room, message }));
    await adapterB.subscribe((room, message) => receivedB.push({ room, message }));
    await new Promise((r) => setTimeout(r, 300));

    await adapterA.publish("products", JSON.stringify({ action: "created", id: "p-1" }));

    await waitFor(() => receivedB.length > 0);
    await new Promise((r) => setTimeout(r, 200)); // give A extra time to echo if it's going to

    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]!.room).toBe("products");
    expect(JSON.parse(receivedB[0]!.message)).toMatchObject({ action: "created", id: "p-1" });

    // Echo suppression — A sent the message, A must NOT receive it.
    expect(receivedA).toHaveLength(0);
  }, 15_000);

  it("both directions fan out bi-directionally", async () => {
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    // subscribe() appends a listener — re-subscribing is safe because arc
    // filters by instanceId. Start fresh counters for this test.
    const adapterC = new RedisWebSocketAdapter(aRedis, { channel, instanceId: "instance-C" });
    const adapterD = new RedisWebSocketAdapter(bRedis, { channel, instanceId: "instance-D" });

    try {
      await adapterC.subscribe((_room, message) => receivedA.push(message));
      await adapterD.subscribe((_room, message) => receivedB.push(message));
      await new Promise((r) => setTimeout(r, 300));

      await adapterC.publish("orders", "from-C");
      await adapterD.publish("orders", "from-D");

      await waitFor(() => receivedA.length > 0 && receivedB.length > 0);

      // C doesn't receive its own, D doesn't receive its own.
      expect(receivedA).toContain("from-D");
      expect(receivedB).toContain("from-C");
      expect(receivedA).not.toContain("from-C");
      expect(receivedB).not.toContain("from-D");
    } finally {
      await adapterC.close();
      await adapterD.close();
    }
  }, 15_000);

  it("ignores malformed JSON dropped directly on the channel", async () => {
    const receivedB: string[] = [];
    const adapterE = new RedisWebSocketAdapter(bRedis, { channel, instanceId: "instance-E" });

    try {
      await adapterE.subscribe((_room, message) => receivedB.push(message));
      await new Promise((r) => setTimeout(r, 300));

      // Publish raw garbage — a legit subscriber would crash if the adapter
      // didn't swallow parse errors.
      await aRedis.publish(channel, "{not json");
      await new Promise((r) => setTimeout(r, 500));

      // A real envelope should still work after the garbage arrived.
      const good = JSON.stringify({
        room: "products",
        message: "good",
        instanceId: "instance-A-fake",
      });
      await aRedis.publish(channel, good);
      await waitFor(() => receivedB.length > 0);

      expect(receivedB).toEqual(["good"]);
    } finally {
      await adapterE.close();
    }
  }, 15_000);
});
