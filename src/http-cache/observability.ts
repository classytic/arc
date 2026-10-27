import type { NonCacheableReason } from "./policy/policy.types.js";
import type { PurgeMode } from "./purgers/purger.types.js";

/** Bounded reason kinds: a metric label never carries a cookie name or header value. */
export type ReasonKind = "header" | "cookie" | "scope" | "classifier" | "status" | "set-cookie";

export const reasonKind = (reason: NonCacheableReason): ReasonKind =>
  (reason.includes(":") ? reason.slice(0, reason.indexOf(":")) : reason) as ReasonKind;

export interface PurgeEvent {
  tags: readonly string[];
  mode: PurgeMode;
  delivery: "batched" | "durable";
  /** `enqueued`: written to the durable store; `sent`: the purger accepted it; `failed`: it threw. */
  outcome: "enqueued" | "sent" | "failed";
  durationMs: number;
  error?: unknown;
}

/** Hooks for metrics/tracing. Called synchronously; never throw from them. */
export interface HttpCacheObserver {
  onDecision?(event: { url: string; cacheable: boolean; reason?: NonCacheableReason }): void;
  onPurge?(event: PurgeEvent): void;
}

export interface HttpCacheStats {
  responses: { public: number; private: Record<ReasonKind, number> };
  purges: { enqueued: number; sent: number; failed: number; tags: number };
  pending: number;
}

export function createStats() {
  const stats: Omit<HttpCacheStats, "pending"> = {
    responses: {
      public: 0,
      private: { header: 0, cookie: 0, scope: 0, classifier: 0, status: 0, "set-cookie": 0 },
    },
    purges: { enqueued: 0, sent: 0, failed: 0, tags: 0 },
  };
  return {
    decision(cacheable: boolean, reason?: NonCacheableReason) {
      if (cacheable) stats.responses.public++;
      else if (reason) stats.responses.private[reasonKind(reason)]++;
    },
    purge(event: PurgeEvent) {
      stats.purges[event.outcome]++;
      if (event.outcome !== "failed") stats.purges.tags += event.tags.length;
    },
    snapshot(pending: number): HttpCacheStats {
      return {
        responses: { public: stats.responses.public, private: { ...stats.responses.private } },
        purges: { ...stats.purges },
        pending,
      };
    },
  };
}
