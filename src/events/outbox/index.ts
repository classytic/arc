/**
 * Outbox public barrel — arc RUNTIME only. The outbox CONTRACT
 * (`OutboxStore`, option types, `OutboxOwnershipError`,
 * `InvalidOutboxEventError`) is owned by `@classytic/primitives/outbox`
 * (>=0.13) and is NOT re-exported here — import it from primitives.
 */

export { type ExponentialBackoffOptions, exponentialBackoff } from "./backoff.js";
export {
  EventOutbox,
  type EventOutboxOptions,
  type OutboxRelayErrorHandler,
  type OutboxRelayErrorKind,
  type RelayResult,
} from "./relay.js";
