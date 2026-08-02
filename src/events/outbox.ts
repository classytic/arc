/**
 * Transactional outbox — public entry. Implementation lives in
 * `./outbox/` (types / relay / backoff); this file preserves the
 * long-standing import path and the `MemoryOutboxStore` re-export.
 */

// ONE canonical in-memory outbox, and it lives in primitives.
//
// arc used to ship a full implementation (leases, retry, dead-letter, dedupe,
// operator counts) while primitives shipped a MINIMAL one (save / getPending /
// acknowledge / purge). Two exported classes, one contract, the same name, very
// different behaviour — a kernel written against primitives' version and run
// against arc's silently gained claim-safety it never tested, and the reverse
// silently lost it.
//
// Primitives owns it because KERNELS need a memory outbox for tests and dev and
// cannot depend on arc, while arc can always depend on primitives. Owning it
// here would have forced every kernel to keep its own copy — which is how the
// drift started (26 in-process-bus and 15 outbox-store copies). Same precedent
// as `MemoryEventTransport`.
export { MemoryOutboxStore } from "@classytic/primitives/memory-outbox";
export * from "./outbox/index.js";
