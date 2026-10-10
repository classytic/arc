import type {} from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createTenantKeyGenerator } from "../scope/rateLimitKey.js";
import type { RequestScope } from "../scope/types.js";

export interface ResourceRateLimitPolicy {
  max: number;
  timeWindow: string;
}

export interface ResourceRateLimitContext {
  scope?: RequestScope;
  ip?: string;
}

/** One resource budget across operations and transports, backed by the host's limiter. */
export interface ResourceRateLimiter {
  readonly durability: "memory" | "shared";
  consume(
    resource: string,
    policy: ResourceRateLimitPolicy,
    context: ResourceRateLimitContext,
  ): Promise<boolean>;
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

/** Uses createRateLimit's store factory, preserving Redis/custom-store configuration. */
export function resolveResourceRateLimiter(
  app: FastifyInstance,
  durability: ResourceRateLimiter["durability"] = "memory",
): ResourceRateLimiter | undefined {
  if (!app.hasDecorator("createRateLimit")) return undefined;
  const existing: unknown = Reflect.get(app, RESOURCE_RATE_LIMITER);
  if (existing) return existing as ResourceRateLimiter;
  const limiters = new Map<string, ReturnType<FastifyInstance["createRateLimit"]>>();
  const limiter: ResourceRateLimiter = {
    durability,
    async consume(resource, policy, context) {
      const identity = JSON.stringify([resource, policy.max, policy.timeWindow]);
      let consume = limiters.get(identity);
      if (!consume) {
        consume = app.createRateLimit({
          ...policy,
          allowList: [],
          skipOnError: false,
          keyGenerator: (req) => req.ip,
        });
        limiters.set(identity, consume);
      }
      // The plugin only needs the supplied key and route config for this numeric policy.
      const req = {
        ip: resourceRateLimitKey(resource, context),
        routeOptions: { config: {} },
      } as FastifyRequest;
      return (await consume(req)).isAllowed;
    },
  };
  Reflect.set(app, RESOURCE_RATE_LIMITER, limiter);
  return limiter;
}

/** Standalone tools may use memory; wired distributed apps use the host's shared store. */
export function createMemoryResourceRateLimiter(capacity = 10000): ResourceRateLimiter {
  const windows = new Map<string, { expires: number; count: number }>();
  return {
    durability: "memory",
    async consume(resource, policy, context) {
      const now = Date.now();
      const key = resourceRateLimitKey(resource, context);
      let slot = windows.get(key);
      if (!slot || slot.expires <= now) {
        if (windows.size >= capacity) {
          for (const [entry, window] of windows) if (window.expires <= now) windows.delete(entry);
          if (!windows.has(key) && windows.size >= capacity) return false;
        }
        slot = { expires: now + resourceRateLimitWindowMs(policy.timeWindow), count: 0 };
        windows.set(key, slot);
      }
      slot.count++;
      return slot.count <= policy.max;
    },
  };
}

export function resourceRateLimitWindowMs(window: string): number {
  const match = /^\s*(\d+)\s*(ms|milliseconds?|seconds?|minutes?|hours?|days?)\s*$/i.exec(window);
  const units: Record<string, number> = {
    ms: 1,
    millisecond: 1,
    second: 1000,
    minute: 60000,
    hour: 3600000,
    day: 86400000,
  };
  const unit = match?.[2]?.toLowerCase().replace(/s$/, "") ?? "";
  const value = Number(match?.[1]) * (units[unit === "m" ? "ms" : unit] ?? 0);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`rateLimit.timeWindow '${window}' must be a positive '<n> <unit>' window.`);
  return value;
}
