/**
 * `@classytic/arc/usage` — per-actor, per-period usage counters.
 *
 * The platform-accounting layer: quotas, plan enforcement inputs, and
 * usage-based billing read from here. See `usagePlugin` for the wire-up
 * and `UsageStore` for the two-method backend contract.
 */

export type { QuotaOptions } from "./requireQuota.js";
export { requireQuota } from "./requireQuota.js";
export type { UsageBucket, UsageStore } from "./stores/interface.js";
export { usagePeriod } from "./stores/interface.js";
export { MemoryUsageStore } from "./stores/memory.js";
export type {
  UsageMeter,
  UsagePluginOptions,
  UsageTrackOptions,
} from "./usagePlugin.js";
export { default, usagePlugin } from "./usagePlugin.js";
