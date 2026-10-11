import type {} from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createTenantKeyGenerator } from "../scope/rateLimitKey.js";
import type { RequestScope } from "../scope/types.js";

export interface ResourceRateLimitPolicy {
  max: number;
  timeWindow: string;
  /** Explicit route overrides own a separate budget. */
  bucket?: string;
}

export interface ResourceRateLimitContext {
  scope?: RequestScope;
  ip?: string;
}

export interface ResourceRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly headers: Readonly<Record<string, number>>;
}

function decision(
  allowed: boolean,
  max: number,
  remaining: number,
  ttlSeconds: number,
): ResourceRateLimitDecision {
  const reset = Math.max(1, ttlSeconds);
  return {
    allowed,
    retryAfterSeconds: reset,
    headers: {
      "x-ratelimit-limit": max,
      "x-ratelimit-remaining": remaining,
      "x-ratelimit-reset": reset,
      ...(!allowed ? { "retry-after": reset } : {}),
    },
  };
}

/** Policy namespacing must reach the store key, not merely the local limiter cache. */
function policyIdentity(resource: string, policy: ResourceRateLimitPolicy): string {
  if (!Number.isSafeInteger(policy.max) || policy.max <= 0)
    throw new Error("rateLimit.max must be a positive safe integer.");
  return JSON.stringify([
    "arc-resource",
    resource,
    policy.bucket ?? "resource",
    policy.max,
    resourceRateLimitWindowMs(policy.timeWindow),
  ]);
}

/** One resource budget across operations and transports, backed by the host's limiter. */
export interface ResourceRateLimiter {
  readonly durability: "memory" | "shared";
  consume(
    resource: string,
    policy: ResourceRateLimitPolicy,
    context: ResourceRateLimitContext,
  ): Promise<ResourceRateLimitDecision>;
}

const RESOURCE_RATE_LIMITER = Symbol.for("arc.resourceRateLimiter");
const tenantKey = createTenantKeyGenerator();

export function resourceRateLimitKey(resource: string, context: ResourceRateLimitContext): string {
  const actor = tenantKey({ scope: context.scope, ip: context.ip ?? "anonymous" });
  const dimension =
    context.scope &&
    context.scope.kind !== "public" &&
    "organizationId" in context.scope &&
    context.scope.organizationId
      ? "tenant"
      : (context.scope?.kind ?? "public");
  return JSON.stringify([resource, dimension, actor]);
}

const RATE_LIMITING_DISABLED = Symbol.for("arc.rateLimitingDisabled");

/**
 * The host said `rateLimit: false`. A resource's declared limit is then a recorded no-op, and
 * the resources are named once at ready. Absent this mark, a declared limit with no limiter
 * refuses to boot: nobody decided, so nothing would enforce it.
 */
export function markRateLimitingDisabled(app: FastifyInstance): void {
  if (Reflect.get(app, RATE_LIMITING_DISABLED)) return;
  const unenforced = new Set<string>();
  Reflect.set(app, RATE_LIMITING_DISABLED, unenforced);
  app.addHook("onReady", async () => {
    if (unenforced.size === 0) return;
    app.log.info(
      { resources: [...unenforced] },
      `[arc] rate limiting is disabled for this app: declared rateLimit not enforced on ${[...unenforced].join(", ")}`,
    );
  });
}

/** Record a resource whose declared limit the host disabled; `false` when the host never decided. */
export function recordUnenforcedRateLimit(app: FastifyInstance, resource: string): boolean {
  let owner: object | null = app;
  while (owner) {
    const unenforced: unknown = Reflect.get(owner, RATE_LIMITING_DISABLED);
    if (unenforced instanceof Set) {
      unenforced.add(resource);
      return true;
    }
    owner = Object.getPrototypeOf(owner);
  }
  return false;
}

/** Uses createRateLimit's store factory, preserving Redis/custom-store configuration. */
export function resolveResourceRateLimiter(
  app: FastifyInstance,
  durability: ResourceRateLimiter["durability"] = "memory",
): ResourceRateLimiter | undefined {
  if (!app.hasDecorator("createRateLimit")) return undefined;
  let owner = app;
  while (!Object.hasOwn(owner, "createRateLimit")) {
    const parent: unknown = Object.getPrototypeOf(owner);
    if (!parent || typeof parent !== "object" || !("createRateLimit" in parent)) break;
    owner = parent as FastifyInstance;
  }
  const existing: unknown = Reflect.get(owner, RESOURCE_RATE_LIMITER);
  if (existing) return existing as ResourceRateLimiter;
  const limiters = new Map<string, ReturnType<FastifyInstance["createRateLimit"]>>();
  const limiter: ResourceRateLimiter = {
    durability,
    async consume(resource, policy, context) {
      const identity = policyIdentity(resource, policy);
      let consume = limiters.get(identity);
      if (!consume) {
        consume = owner.createRateLimit({
          max: policy.max,
          timeWindow: resourceRateLimitWindowMs(policy.timeWindow),
          allowList: [],
          skipOnError: false,
          keyGenerator: (req) => req.ip,
        });
        limiters.set(identity, consume);
      }
      // The plugin only needs the supplied key and route config for this numeric policy.
      const req = {
        ip: JSON.stringify([identity, resourceRateLimitKey(resource, context)]),
        routeOptions: { config: {} },
      } as FastifyRequest;
      const result = await consume(req);
      return result.isAllowed
        ? decision(
            true,
            policy.max,
            policy.max,
            Math.ceil(resourceRateLimitWindowMs(policy.timeWindow) / 1000),
          )
        : decision(!result.isExceeded, result.max, result.remaining, result.ttlInSeconds);
    },
  };
  Reflect.set(owner, RESOURCE_RATE_LIMITER, limiter);
  return limiter;
}

/** Standalone tools may use memory; wired distributed apps use the host's shared store. */
export function createMemoryResourceRateLimiter(capacity = 10000): ResourceRateLimiter {
  if (!Number.isSafeInteger(capacity) || capacity <= 0)
    throw new Error("rateLimit memory capacity must be a positive safe integer.");
  const windows = new Map<string, { expires: number; count: number }>();
  return {
    durability: "memory",
    async consume(resource, policy, context) {
      const now = Date.now();
      const windowMs = resourceRateLimitWindowMs(policy.timeWindow);
      const key = JSON.stringify([
        policyIdentity(resource, policy),
        resourceRateLimitKey(resource, context),
      ]);
      let slot = windows.get(key);
      if (!slot || slot.expires <= now) {
        if (windows.size >= capacity) {
          for (const [entry, window] of windows) if (window.expires <= now) windows.delete(entry);
          if (!windows.has(key) && windows.size >= capacity) {
            let retryMs = Number.POSITIVE_INFINITY;
            for (const entry of windows.values()) retryMs = Math.min(retryMs, entry.expires - now);
            return decision(false, policy.max, 0, Math.ceil(retryMs / 1000));
          }
        }
        slot = { expires: now + windowMs, count: 0 };
        windows.set(key, slot);
      }
      slot.count++;
      return decision(
        slot.count <= policy.max,
        policy.max,
        Math.max(0, policy.max - slot.count),
        Math.ceil((slot.expires - now) / 1000),
      );
    },
  };
}

export function resourceRateLimitWindowMs(window: string): number {
  const match =
    /^\s*((?:\d+(?:\.\d+)?|\.\d+))\s*(ms|milliseconds?|msecs?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|y|yrs?|years?)?\s*$/i.exec(
      window,
    );
  const units: Record<string, number> = {
    ms: 1,
    millisecond: 1,
    milliseconds: 1,
    msec: 1,
    msecs: 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60000,
    min: 60000,
    mins: 60000,
    minute: 60000,
    minutes: 60000,
    h: 3600000,
    hr: 3600000,
    hrs: 3600000,
    hour: 3600000,
    hours: 3600000,
    d: 86400000,
    day: 86400000,
    days: 86400000,
    w: 604800000,
    wk: 604800000,
    wks: 604800000,
    week: 604800000,
    weeks: 604800000,
    y: 31557600000,
    yr: 31557600000,
    yrs: 31557600000,
    year: 31557600000,
    years: 31557600000,
  };
  const value = Number(match?.[1]) * (units[match?.[2]?.toLowerCase() ?? "ms"] ?? 0);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(
      `rateLimit.timeWindow '${window}' must be a positive duration in milliseconds.`,
    );
  return value;
}
