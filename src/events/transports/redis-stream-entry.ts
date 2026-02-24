/**
 * Redis Stream Event Transport — Dedicated Entry Point
 *
 * Import from '@classytic/arc/events/redis-stream' to avoid pulling
 * ioredis into your bundle when using in-memory transport.
 *
 * @example
 * import { RedisStreamTransport } from '@classytic/arc/events/redis-stream';
 */
export { RedisStreamTransport } from './redis-stream.js';
export type { RedisStreamLike, RedisStreamTransportOptions } from './redis-stream.js';
