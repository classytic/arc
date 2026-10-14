/**
 * Route registration — the one place every arc router hands a route to Fastify: arc's request
 * validator, the idempotency-declaration fence, and duplicate-route diagnostics.
 */

import type { RouteOptions } from "fastify";
import {
  declaresIdempotencyFence,
  idempotencyConfigProblem,
} from "../../idempotency/requirement.js";
import {
  recordUnenforcedRateLimit,
  resolveResourceRateLimiter,
} from "../../permissions/resourceRateLimit.js";
import type { FastifyWithDecorators } from "../../types/index.js";
import { arcRouteValidatorCompiler } from "../routeValidator.js";
import { isReplayBoundary, isValidationGate } from "./chain.js";

/**
 * Register a route with friendly handling of `FST_ERR_DUPLICATED_ROUTE`.
 *
 * Boot-time `validateRouteCrudCollisions()` catches custom-route → auto-CRUD
 * overlaps before Fastify ever runs, but a few cases still slip through to
 * Fastify itself: two presets contributing the same `routes` entry, hosts
 * mounting two resources at the same prefix, custom routes that share a
 * URL with another plugin. Fastify's default message ("Method 'GET'
 * already declared for route '/'") gives no hint at the resource-shaped
 * fix — `disabledRoutes: ['list']` — so wrap it with one.
 */
export function tryRegisterRoute(
  fastify: FastifyWithDecorators,
  opts: RouteOptions,
  context: { resourceName: string; op?: string; rateLimitBucket?: string },
): void {
  const ratePolicy = opts.config?.rateLimit;
  if (
    ratePolicy &&
    typeof ratePolicy === "object" &&
    typeof ratePolicy.max === "number" &&
    typeof ratePolicy.timeWindow === "string"
  ) {
    const limiter = resolveResourceRateLimiter(fastify);
    if (!limiter && !recordUnenforcedRateLimit(fastify, context.resourceName))
      throw new Error(
        `[arc] Resource "${context.resourceName}" declares rateLimit; register @fastify/rate-limit before mounting the resource, or disable rate limiting for the app (createApp({ rateLimit: false })).`,
      );
    if (!limiter) {
      opts = { ...opts, config: { ...opts.config, rateLimit: false } };
    } else {
      const policy = {
        max: ratePolicy.max,
        timeWindow: ratePolicy.timeWindow,
        bucket: context.rateLimitBucket,
      };
      const handlers = Array.isArray(opts.preHandler)
        ? opts.preHandler
        : opts.preHandler
          ? [opts.preHandler]
          : [];
      const limit: import("fastify").preHandlerAsyncHookHandler = async (req, reply) => {
        const decision = await limiter.consume(context.resourceName, policy, {
          scope: req.scope,
          ip: req.ip,
        });
        for (const [header, value] of Object.entries(decision.headers)) reply.header(header, value);
        if (!decision.allowed) {
          await reply.code(429).send({
            code: "arc.rate_limited",
            message: "Too many calls to this resource — retry later.",
            status: 429,
          });
        }
      };
      const replayIndex = handlers.findIndex(isReplayBoundary);
      const at = replayIndex < 0 ? handlers.length : replayIndex;
      opts = {
        ...opts,
        config: { ...opts.config, rateLimit: false },
        preHandler: [...handlers.slice(0, at), limit, ...handlers.slice(at)],
      };
    }
  }
  const problem = idempotencyConfigProblem(opts.config);
  if (problem) {
    throw new Error(
      `[arc] ${String(opts.method)} ${opts.url} on resource "${context.resourceName}": config.idempotency: ${problem}.`,
    );
  }
  // A declared fence with no plugin to run it would accept the key and execute every retry.
  // (A REGISTERED plugin checks its own routes — disabled or middleware-less — at `onRoute`.)
  if (declaresIdempotencyFence(opts.config) && !fastify.hasDecorator("idempotency")) {
    throw new Error(
      `[arc] ${String(opts.method)} ${opts.url} on resource "${context.resourceName}" declares ` +
        "config.idempotency.required, but idempotencyPlugin is not registered — register it " +
        "(enabled) before the resources, or drop the declaration.",
    );
  }
  // A parked validation error with no gate to rethrow it hands invalid input to the handler.
  if (opts.attachValidation === true) {
    const preHandlers = Array.isArray(opts.preHandler) ? opts.preHandler : [opts.preHandler];
    if (!preHandlers.some(isValidationGate)) {
      throw new Error(
        `[arc] ${String(opts.method)} ${opts.url} on resource "${context.resourceName}" sets ` +
          "attachValidation without arc's validation gate — build its hooks with buildRouteHooks.",
      );
    }
  }
  const validatorCompiler = opts.validatorCompiler ?? arcRouteValidatorCompiler(fastify);
  try {
    fastify.route(validatorCompiler ? { ...opts, validatorCompiler } : opts);
  } catch (err) {
    const fastifyErr = err as { code?: string; message?: string };
    if (fastifyErr?.code !== "FST_ERR_DUPLICATED_ROUTE") throw err;

    const method = (opts as { method: string }).method;
    const url = (opts as { url: string }).url;
    const opHint = context.op ? ` (op: ${context.op})` : "";
    const fixHint =
      context.op && ["list", "get", "create", "update", "delete"].includes(context.op)
        ? ` Suppress the auto-CRUD route with \`disabledRoutes: ['${context.op}']\`.`
        : " If a custom route in `routes:` collides with auto-CRUD, add" +
          " `disabledRoutes: ['list' | 'get' | 'create' | 'update' | 'delete']`" +
          " to `defineResource()` to suppress the matching auto-CRUD route.";

    const enhanced = new Error(
      `[arc] Duplicate route ${method} ${url} on resource "${context.resourceName}"${opHint}.${fixHint}` +
        ` Original: ${fastifyErr.message ?? "FST_ERR_DUPLICATED_ROUTE"}`,
    );
    (enhanced as { code?: string }).code = "FST_ERR_DUPLICATED_ROUTE";
    (enhanced as { cause?: unknown }).cause = err;
    throw enhanced;
  }
}
