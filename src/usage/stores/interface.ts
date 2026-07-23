/**
 * Usage store contract — period-bucketed counters per actor.
 *
 * CANONICAL HOME: `@classytic/repo-core/usage` owns this contract for the
 * ecosystem — kits implement it there without ever depending on arc
 * (`@classytic/mongokit/usage`, ...). Arc re-exports the canonical types
 * verbatim so drift between arc and the ecosystem contract is structurally
 * impossible.
 *
 * The deliberately tiny surface (one increment, one read) is what makes
 * every backend trivial: memory (dev/tests), Redis (`HINCRBY`), or any kit
 * (Mongo `$inc` upsert) implements it in a handful of lines. Aggregation
 * happens IN the store — arc never buffers counters in process memory
 * beyond the built-in memory store, so multi-replica deployments stay
 * correct as long as the store is shared.
 *
 * This is the HORIZONTAL usage layer (per-actor, per-period platform
 * accounting for quotas/plans/billing). Itemized vertical records — e.g.
 * `@classytic/arc-ai/usage`'s per-run AI token/cost tracking — keep their
 * own richer stores and can sink into this one (`kind: 'ai.tokens'`).
 */

export type { UsageBucket, UsageStore } from "@classytic/repo-core/usage";
export { usagePeriod } from "@classytic/repo-core/usage";
