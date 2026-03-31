/**
 * MongoDB Idempotency Store — Dedicated Entry Point
 *
 * Import from '@classytic/arc/idempotency/mongodb' to avoid pulling mongoose
 * into your bundle when using in-memory idempotency store.
 *
 * @example
 * import { MongoIdempotencyStore } from '@classytic/arc/idempotency/mongodb';
 *
 * const store = new MongoIdempotencyStore({ connection: mongoose.connection });
 */

export type { MongoIdempotencyStoreOptions } from "./stores/mongodb.js";
export { MongoIdempotencyStore } from "./stores/mongodb.js";
