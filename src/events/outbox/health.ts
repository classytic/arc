/**
 * Outbox health — ONE computation, read by the outbox module's readiness check and
 * the operator `/health` route, so the two can never disagree.
 *
 * Unhealthy when anything is dead-lettered OR the oldest pending event is older than
 * the lag threshold. Keying off either signal alone reports healthy for a relay wedged
 * behind a poison row, or for a queue quietly filling with nobody draining it.
 */
import type { OutboxStore } from "@classytic/primitives/outbox";

/** Pending age past which the relay counts as stalled. */
export const DEFAULT_RELAY_LAG_UNHEALTHY_MS = 5 * 60_000;

export interface OutboxHealth {
  pending: number;
  deadLetter: number;
  /** Age of the oldest pending event, `null` when nothing is pending. */
  relayLagMs: number | null;
  healthy: boolean;
}

/** A store that can report its own depth — both reads are optional on the contract. */
export type OutboxHealthStore = OutboxStore &
  Required<Pick<OutboxStore, "countByStatus" | "oldestPendingAgeMs">>;

export function canReportHealth(store: OutboxStore): store is OutboxHealthStore {
  return (
    typeof store.countByStatus === "function" && typeof store.oldestPendingAgeMs === "function"
  );
}

export async function readOutboxHealth(
  store: OutboxHealthStore,
  relayLagUnhealthyMs: number = DEFAULT_RELAY_LAG_UNHEALTHY_MS,
): Promise<OutboxHealth> {
  const [pending, deadLetter, relayLagMs] = await Promise.all([
    store.countByStatus("pending"),
    store.countByStatus("dead_letter"),
    store.oldestPendingAgeMs(),
  ]);
  const healthy = deadLetter === 0 && (relayLagMs === null || relayLagMs < relayLagUnhealthyMs);
  return { pending, deadLetter, relayLagMs, healthy };
}
