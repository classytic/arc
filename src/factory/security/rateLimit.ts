/**
 * Rate-limit option building — expands arc's sugar (`plan`, `skipPaths`)
 * into `@fastify/rate-limit` primitives.
 *
 * Pure functions over the options bag: no Fastify instance, no I/O — unit-
 * testable in isolation. Registration (WHEN to apply these options, store
 * warnings, distributed-runtime gates) lives in `../registerSecurity.ts`.
 */

import type { FastifyRequest } from "fastify";
import { createTenantKeyGenerator } from "../../scope/rateLimitKey.js";
import type { RateLimitPlanConfig } from "../types/index.js";

export type RateLimitAllowList =
  | string[]
  | ((req: FastifyRequest, key: string) => boolean | Promise<boolean>);

/** "Unlimited" as a number — @fastify/rate-limit's `max` fn must return one. */
const UNLIMITED_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Expand `plan` sugar (2.22) into `@fastify/rate-limit` primitives: a
 * per-request async `max` that resolves the caller's plan once (cached
 * per request), and — unless the host supplied one — the tenant
 * keyGenerator so buckets follow actors, not IPs. Unknown plans and
 * resolver errors fall back to `plan.default`, then the global `max`
 * (fail-safe: never fail-open to unlimited).
 */
function buildPlanOpts(
  rest: Record<string, unknown> & { max?: number },
  plan: RateLimitPlanConfig,
): Record<string, unknown> {
  const globalMax = typeof rest.max === "number" ? rest.max : 100;
  const fallbackLimit =
    plan.default !== undefined
      ? (plan.limits[plan.default] ?? { max: globalMax })
      : { max: globalMax };

  const planCache = new WeakMap<object, Promise<{ max: number } | false>>();
  const limitOf = (req: FastifyRequest): Promise<{ max: number } | false> => {
    let cached = planCache.get(req);
    if (!cached) {
      cached = Promise.resolve()
        .then(() => plan.resolve(req))
        .then((name) => (name !== undefined ? (plan.limits[name] ?? fallbackLimit) : fallbackLimit))
        .catch(() => fallbackLimit);
      planCache.set(req, cached);
    }
    return cached;
  };

  return {
    ...rest,
    max: async (req: FastifyRequest, _key: string): Promise<number> => {
      const limit = await limitOf(req);
      return limit === false ? UNLIMITED_MAX : limit.max;
    },
    keyGenerator: rest.keyGenerator ?? createTenantKeyGenerator(),
  };
}

/**
 * Translate `skipPaths` sugar into a `@fastify/rate-limit` `allowList`
 * function. A user-supplied `allowList` (array of IPs or function) is
 * preserved and OR-ed with the path match.
 */
export function buildRateLimitOpts(input: Record<string, unknown>): Record<string, unknown> {
  const { skipPaths, allowList, plan, ...bare } = input as Record<string, unknown> & {
    skipPaths?: string[];
    allowList?: RateLimitAllowList;
    plan?: RateLimitPlanConfig;
  };

  const rest = plan ? buildPlanOpts(bare, plan) : bare;

  if (!skipPaths || skipPaths.length === 0) {
    return allowList === undefined ? rest : { ...rest, allowList };
  }

  const matchesPath = compilePathMatcher(skipPaths);

  const combined: RateLimitAllowList = async (req, key) => {
    const path = (req.url ?? "").split("?", 1)[0] ?? "";
    if (matchesPath(path)) return true;
    if (typeof allowList === "function") return await allowList(req, key);
    if (Array.isArray(allowList)) return allowList.includes(key);
    return false;
  };

  return { ...rest, allowList: combined };
}

function compilePathMatcher(patterns: string[]): (path: string) => boolean {
  const prefixes: string[] = [];
  const exact = new Set<string>();
  for (const p of patterns) {
    if (p.endsWith("*")) prefixes.push(p.slice(0, -1));
    else exact.add(p);
  }
  return (path: string): boolean => {
    if (exact.has(path)) return true;
    for (const pre of prefixes) {
      if (path.startsWith(pre)) return true;
    }
    return false;
  };
}
