/**
 * Rate-limit option building — expands arc's sugar (`plan`, `skipPaths`)
 * into `@fastify/rate-limit` primitives.
 *
 * Pure functions over the options bag: no Fastify instance, no I/O — unit-
 * testable in isolation. Registration (WHEN to apply these options, store
 * warnings, distributed-runtime gates) lives in `../registerSecurity.ts`.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createTenantKeyGenerator,
  ipBucket,
  isScopeAwareKeyGenerator,
} from "../../scope/rateLimitKey.js";
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
  const {
    skipPaths,
    allowList: hostAllowList,
    plan,
    ipCeiling: _ipCeiling,
    ...bare
  } = input as Record<string, unknown> & {
    skipPaths?: string[];
    allowList?: RateLimitAllowList;
    plan?: RateLimitPlanConfig;
    ipCeiling?: unknown;
  };
  let allowList = hostAllowList;

  if (usesDefaultKey(input)) {
    bare.keyGenerator = createTenantKeyGenerator({ strategy: "user" });
    // A signed-in caller's key is `user:<id>`, so an allowList of ADDRESSES would stop
    // matching them; compare it against the client IP as well as the key.
    if (Array.isArray(allowList)) {
      const list = allowList;
      allowList = (req, key) => list.includes(key) || list.includes(req.ip);
    }
  }

  applyScopeAwareHook(bare);

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

/**
 * Arc's default key: per signed-in user, per IP when anonymous, at `preHandler`. Applies
 * only when the host chose nothing — no `keyGenerator`, no `plan`, and no explicit
 * `hook: 'onRequest'` (which cannot see a user, so it keeps the plugin's per-IP key rather
 * than failing boot).
 */
function usesDefaultKey(input: Record<string, unknown>): boolean {
  return input.keyGenerator === undefined && input.plan === undefined && input.hook !== "onRequest";
}

/** Floor and multiplier for the default early per-IP ceiling (see `resolveIpCeiling`). */
const IP_CEILING_FLOOR = 2000;
const IP_CEILING_FACTOR = 20;
/** `@fastify/rate-limit`'s own `max` when none is given. */
const PLUGIN_DEFAULT_MAX = 1000;

export interface IpCeiling {
  readonly max: number;
  readonly timeWindow: number | string;
}

/**
 * The cheap early guard that rides alongside the default per-user key.
 *
 * The per-user limit runs at `preHandler`, so traffic that never reaches one (unmatched
 * routes, requests that fail auth first) would otherwise go uncounted. The ceiling counts
 * every request per IP at `onRequest`, before body parsing and auth, with a deliberately
 * high budget: `max(2000, 20 × max)` per window (2000/min at arc's default `max: 100`).
 * That is ~33 req/s from one address: an office of ~100 people actively using an app
 * shares it comfortably, while a scripted flood still trips it.
 *
 * Only with the default key; `ipCeiling: false` drops it, a number sets it.
 */
export function resolveIpCeiling(input: Record<string, unknown>): IpCeiling | undefined {
  if (!usesDefaultKey(input)) return undefined;
  const configured = input.ipCeiling;
  if (configured === false) return undefined;
  const timeWindow =
    typeof input.timeWindow === "number" || typeof input.timeWindow === "string"
      ? input.timeWindow
      : "1 minute";
  if (configured !== undefined) {
    if (typeof configured !== "number" || !Number.isSafeInteger(configured) || configured <= 0) {
      throw new Error("[arc] rateLimit.ipCeiling must be a positive integer or false.");
    }
    return { max: configured, timeWindow };
  }
  const base =
    typeof input.max === "number"
      ? input.max
      : input.max === undefined
        ? PLUGIN_DEFAULT_MAX
        : IP_CEILING_FLOOR / IP_CEILING_FACTOR;
  return { max: Math.max(IP_CEILING_FLOOR, base * IP_CEILING_FACTOR), timeWindow };
}

type CeilingLimiter = (req: FastifyRequest) => Promise<{
  isAllowed: boolean;
  isExceeded?: boolean;
  key: string;
  max?: number;
  ttl?: number;
  ttlInSeconds?: number;
}>;

/**
 * Install the early per-IP ceiling on the SAME `@fastify/rate-limit` registration
 * (`createRateLimit`), so it shares the host's store, `allowList` and `skipPaths`.
 *
 * A second plugin registration was rejected: `@fastify/rate-limit` applies every route's
 * `config.rateLimit` override in EVERY registration, so a route limit would be counted a
 * second time per IP — the NAT throttling this default removes. `fastify.rateLimit()` was
 * rejected too: it shares the per-request "already ran" marker, so it would switch off the
 * per-user limit. Keys carry an `arc-ip-ceiling:` prefix so a shared store never mixes them
 * with the anonymous per-IP bucket.
 *
 * Must run after the plugin is registered. Store errors fail open: the per-user limiter
 * still governs, and this is a coarse flood guard, not the limit.
 */
export function installIpCeiling(
  fastify: FastifyInstance,
  ceiling: IpCeiling | undefined,
  opts: Record<string, unknown>,
): void {
  if (!ceiling) return;
  const create = Reflect.get(fastify, "createRateLimit") as
    | ((options: Record<string, unknown>) => CeilingLimiter)
    | undefined;
  if (typeof create !== "function") return;
  const limiter = create.call(fastify, {
    max: ceiling.max,
    timeWindow: ceiling.timeWindow,
    keyGenerator: (req: FastifyRequest) => `arc-ip-ceiling:${ipBucket(req.ip)}`,
  });
  const onExceeded =
    typeof opts.onExceeded === "function"
      ? (opts.onExceeded as (req: FastifyRequest, key: string) => void)
      : undefined;
  const buildError =
    typeof opts.errorResponseBuilder === "function"
      ? (opts.errorResponseBuilder as (
          req: FastifyRequest,
          ctx: Record<string, unknown>,
        ) => unknown)
      : undefined;

  fastify.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions?.config?.rateLimit === false) return;
    let result: Awaited<ReturnType<CeilingLimiter>>;
    try {
      result = await limiter(req);
    } catch (err) {
      req.log.debug({ err }, "[arc] rate-limit ip ceiling: store error, request let through");
      return;
    }
    if (result.isAllowed || !result.isExceeded) return;
    const seconds = Math.max(1, result.ttlInSeconds ?? 1);
    onExceeded?.(req, result.key);
    reply.header("retry-after", seconds);
    const context = {
      statusCode: 429,
      ban: false,
      max: result.max ?? ceiling.max,
      ttl: result.ttl ?? seconds * 1000,
      after: `${seconds} second${seconds === 1 ? "" : "s"}`,
    };
    if (buildError) throw buildError(req, context);
    throw Object.assign(new Error(`Rate limit exceeded, retry in ${context.after}`), {
      statusCode: 429,
    });
  });
}

/**
 * A scope-keyed generator must run AFTER authentication, so arc places the hook itself.
 *
 * `@fastify/rate-limit` defaults to `onRequest`; arc authenticates in a `preHandler`. A
 * generator from `createTenantKeyGenerator` therefore saw `PUBLIC_SCOPE` and returned the
 * caller's IP for EVERY request — and behind a proxy with `trustProxy` unset that is one
 * address, so a whole deployment shared a single bucket. Nothing threw: the limiter ran,
 * the host's key function ran, and the answer was silently wrong.
 *
 * Defaulted rather than merely warned, because the correct value is knowable here and the
 * failure is unobservable in production. An explicit `onRequest` is REFUSED rather than
 * honoured — it cannot do what the caller is asking for.
 */
function applyScopeAwareHook(bare: Record<string, unknown>): void {
  if (!isScopeAwareKeyGenerator(bare.keyGenerator)) return;

  if (bare.hook === undefined) {
    bare.hook = "preHandler";
    return;
  }

  if (bare.hook === "onRequest") {
    throw new Error(
      "[arc] rateLimit.hook: 'onRequest' cannot be combined with a scope-aware keyGenerator " +
        "(createTenantKeyGenerator). Authentication runs in a preHandler, so the generator would " +
        "see PUBLIC_SCOPE and key every caller by IP — behind a proxy that is one bucket for the " +
        "whole deployment. Use hook: 'preHandler' (arc's default for this generator), or supply a " +
        "keyGenerator that derives identity without the scope.",
    );
  }
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
