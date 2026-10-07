/**
 * Read the DURABLE attempt count a store reports on a fenced claim.
 *
 * `OutboxClaimedEvent.attempts` is newer than arc's `@classytic/primitives`
 * peer floor, so arc reads it STRUCTURALLY instead of raising that floor for
 * one optional field: a store built against a primitives that declares it
 * reports it, and an older store simply leaves it absent — which callers treat
 * exactly like a store that never counted.
 *
 * One function rather than a cast at each read site, so the day the floor
 * moves past the release that declares the field this collapses to
 * `claimed.attempts` in one place.
 */

import type { OutboxClaimedEvent } from "@classytic/primitives/outbox";

export function claimedAttempts(claimed: OutboxClaimedEvent): number | undefined {
  const value = (claimed as OutboxClaimedEvent & { readonly attempts?: unknown }).attempts;
  // A store reporting something that is not a positive integer is reporting
  // nothing a failure policy can use; fall back to the relay's own count.
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
