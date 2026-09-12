/**
 * A real ioredis `Redis` must satisfy every `*Like` client shape arc declares.
 *
 * Arc types its Redis dependencies structurally so no subpath takes a
 * typecheck-time dep on ioredis. ioredis types each command as OVERLOADS whose
 * variadic tails mix literal tokens (`'MATCH'`, `'EX'`), `Buffer`, and an
 * optional callback — so a shape with a narrower tail such as
 * `(string | number)[]` matches none of them and `ioredisAsIdempotencyClient(
 * new Redis(url))` (arc's own docblock example) failed with TS2345. Pinned
 * here for every shape at once; the tails are `unknown[]` for this reason.
 *
 * Compile-time-only, as plain assignments — exactly what a host writes.
 * (`expectTypeOf().toExtend` applies a stricter relation than assignability
 * and rejects the overloaded stream client that assignment accepts.) The
 * function is never called; the file passing `tsc -p tsconfig.types.json` is
 * the assertion.
 */

import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import type { RedisLike as SessionRedisLike } from "../../src/auth/redis-session.js";
import type { IoredisLike as CacheIoredisLike } from "../../src/cache/redis.js";
import type { RedisLike as PubSubRedisLike } from "../../src/events/transports/redis.js";
import type { RedisStreamLike } from "../../src/events/transports/redis-stream.js";
import type { IoredisLike as IdempotencyIoredisLike } from "../../src/idempotency/stores/redis.js";
import type { RedisLike as PushRefRedisLike } from "../../src/integrations/websocket-pushref-redis.js";
import type { RedisLike as WsRedisLike } from "../../src/integrations/websocket-redis.js";

function assignable(redis: Redis): void {
  // The documented `ioredisAs*Client(new Redis())` paths.
  const idempotency: IdempotencyIoredisLike = redis;
  const cache: CacheIoredisLike = redis;
  // Events transports.
  const stream: RedisStreamLike = redis;
  const pubsub: PubSubRedisLike = redis;
  // Sessions + websocket (adapter, pushRef store).
  const sessions: SessionRedisLike = redis;
  const ws: WsRedisLike = redis;
  const pushRef: PushRefRedisLike = redis;
  void [idempotency, cache, stream, pubsub, sessions, ws, pushRef];
}

describe("ioredis `Redis` is assignable to every arc Redis-like shape", () => {
  it("compiles — see the header; this body only keeps the file in the runtime suite", () => {
    expect(typeof assignable).toBe("function");
  });
});
