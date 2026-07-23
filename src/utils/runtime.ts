/**
 * Cross-runtime "run after the current task" scheduler — re-exported from
 * the canonical implementation in `@classytic/repo-core/cache`.
 *
 * The canonical helper uses `setImmediate` on Node/Bun and `setTimeout(0)`
 * elsewhere — never `queueMicrotask`, which flushes BEFORE the current I/O
 * phase completes and would let background work (e.g. an SWR refresh)
 * delay the response write it is supposed to run after.
 */
export { scheduleBackground } from "@classytic/repo-core/cache";
