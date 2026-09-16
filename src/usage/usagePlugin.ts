/**
 * Usage Plugin — per-actor, per-period platform usage counters.
 *
 * The accounting primitive quotas, plan limits, and usage-based billing
 * are built on. One decoration (`fastify.usage`), one store contract
 * (`UsageStore`), and opt-out zero-config tracking of API requests +
 * response bytes.
 *
 * Three stores answer `runtime: 'distributed'`'s `usage.store` violation:
 * `RedisUsageStore` (shipped here — `HINCRBY`, the right shape for a hot
 * per-request counter), a kit's (`@classytic/mongokit/usage`, when the
 * counters belong beside your domain data in one backup), or your own —
 * the contract is two methods.
 *
 * ```typescript
 * import { usagePlugin, RedisUsageStore } from '@classytic/arc/usage';
 * import Redis from 'ioredis';
 *
 * await app.register(usagePlugin, {
 *   store: new RedisUsageStore({ redis: new Redis(process.env.REDIS_URL) }),
 * });
 *
 * // Automatic: 'api.requests' (+ 'api.egress.bytes') per actor per month.
 * // Manual — anything your product sells:
 * app.usage.record(request.scope, 'export.rows', 1200);
 * app.usage.record('org-42', 'ai.tokens', 15_000);
 *
 * await app.usage.summary('org-42');           // current period
 * await app.usage.summary('org-42', '2026-06'); // a past month
 * ```
 *
 * Actor derivation follows the same chain as arc's tenant rate-limit
 * keys: organization → user → client → `ip:<addr>` — so usage buckets
 * and rate-limit buckets describe the same actor.
 *
 * Recording is fire-and-forget: a failing store NEVER fails a request
 * (errors surface via `log.debug`). Pair with `rateLimit.plan` for
 * enforcement — usage answers "how much", plans answer "how fast".
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { getClientId, getOrgId, getUserId } from "../scope/index.js";
import type { RequestScope } from "../scope/types.js";
import { declareRuntimeCapability } from "../utils/runtimeCapabilities.js";
import type { UsageStore } from "./stores/interface.js";
import { usagePeriod } from "./stores/interface.js";
import { MemoryUsageStore } from "./stores/memory.js";

export interface UsageTrackOptions {
  /** Count every completed request as `api.requests` (default: true). */
  requests?: boolean;
  /** Sum `content-length` response bytes as `api.egress.bytes` (default: false). */
  egress?: boolean;
}

export interface UsagePluginOptions {
  /** Master switch — `false` registers a typed no-op (config-gated environments). */
  enabled?: boolean;
  /** Counter backend. Default: in-memory (per-process — use a shared store in multi-replica). */
  store?: UsageStore;
  /** Automatic per-request accounting. Default: `{ requests: true, egress: false }`. */
  track?: UsageTrackOptions;
  /**
   * Derive the actor key from a request. Default: org → user → client →
   * `ip:<addr>` (same chain as `createTenantKeyGenerator`).
   */
  actorOf?: (request: FastifyRequest) => string | undefined;
  /**
   * Paths exempt from automatic tracking. Exact or trailing-`*` prefix.
   * Default: `['/_health*', '/_metrics*']`.
   */
  ignorePaths?: string[];
}

/** The `fastify.usage` surface. */
export interface UsageMeter {
  /**
   * Add to a counter. `actor` may be a raw key or a `RequestScope`
   * (derived via the org → user → client chain). Fire-and-forget safe:
   * awaiting is optional, errors never throw into request flow.
   */
  record(actor: string | RequestScope | undefined, kind: string, amount?: number): Promise<void>;
  /** All counters for an actor. Period defaults to the current month. */
  summary(actor: string, period?: string): Promise<Record<string, number>>;
  /** Canonical period key (`YYYY-MM`) for a date. */
  period(date?: Date): string;
  /** The actor key automatic tracking would use for this request. */
  actorOf(request: FastifyRequest): string;
  /** The active store (diagnostics). */
  readonly store: UsageStore;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Per-actor usage counters — registered by `usagePlugin`. */
    usage?: UsageMeter;
  }
}

function actorFromScope(scope: RequestScope | undefined): string | undefined {
  if (!scope) return undefined;
  return getOrgId(scope) ?? getUserId(scope) ?? getClientId(scope);
}

function compileIgnore(patterns: string[]): (path: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of patterns) {
    if (p.endsWith("*")) prefixes.push(p.slice(0, -1));
    else exact.add(p);
  }
  return (path) => exact.has(path) || prefixes.some((pre) => path.startsWith(pre));
}

const usagePluginFn: FastifyPluginAsync<UsagePluginOptions> = async (fastify, opts) => {
  const { enabled = true } = opts;

  if (!enabled) {
    const noopStore = new MemoryUsageStore();
    const noop: UsageMeter = {
      record: async () => undefined,
      summary: async () => ({}),
      period: usagePeriod,
      actorOf: (request) => `ip:${request.ip}`,
      store: noopStore,
    };
    fastify.decorate("usage", noop);
    fastify.log.debug("usagePlugin disabled — registered as no-op");
    return;
  }

  const store: UsageStore = opts.store ?? new MemoryUsageStore();
  // Runtime capability: the default store counts per process — a quota read
  // on one replica misses every request the others served. A host-supplied
  // store is presumed shared (it exists to be).
  declareRuntimeCapability(fastify, {
    subsystem: "usage.store",
    durability: opts.store ? "shared" : "memory",
    detail: "default MemoryUsageStore: counters are replica-local",
  });
  const track = { requests: true, egress: false, ...opts.track };
  const ignores = compileIgnore(opts.ignorePaths ?? ["/_health*", "/_metrics*"]);

  const defaultActorOf = (request: FastifyRequest): string => {
    const scoped = actorFromScope((request as FastifyRequest & { scope?: RequestScope }).scope);
    return scoped ?? `ip:${request.ip}`;
  };
  const actorOf = (request: FastifyRequest): string =>
    opts.actorOf?.(request) ?? defaultActorOf(request);

  async function record(
    actor: string | RequestScope | undefined,
    kind: string,
    amount = 1,
  ): Promise<void> {
    if (!Number.isFinite(amount) || amount === 0) return;
    const key = typeof actor === "string" ? actor : (actorFromScope(actor) ?? "anonymous");
    try {
      await store.increment({ actor: key, period: usagePeriod(), kind }, amount);
    } catch (err) {
      // Accounting must never take a request down with it.
      fastify.log.debug({ err, kind }, "[arc-usage] increment failed");
    }
  }

  const meter: UsageMeter = {
    record,
    summary: (actor, period) => store.summary(actor, period ?? usagePeriod()),
    period: usagePeriod,
    actorOf,
    store,
  };
  fastify.decorate("usage", meter);

  if (track.requests || track.egress) {
    fastify.addHook("onResponse", async (request, reply) => {
      const path = (request.url ?? "").split("?", 1)[0] ?? "";
      if (ignores(path)) return;
      const actor = actorOf(request);
      if (track.requests) void record(actor, "api.requests", 1);
      if (track.egress) {
        const len = Number(reply.getHeader("content-length"));
        if (Number.isFinite(len) && len > 0) void record(actor, "api.egress.bytes", len);
      }
    });
  }

  fastify.addHook("onClose", async () => {
    await store.close?.();
  });
};

export default fp(usagePluginFn, {
  name: "arc-usage",
  fastify: "5.x",
});

export { usagePluginFn as usagePlugin };
