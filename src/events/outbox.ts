/**
 * Transactional outbox — public entry. Implementation lives in
 * `./outbox/` (types / relay / backoff); this file preserves the
 * long-standing import path and the `MemoryOutboxStore` re-export.
 */

export { MemoryOutboxStore } from "./memory-outbox.js";
export * from "./outbox/index.js";
