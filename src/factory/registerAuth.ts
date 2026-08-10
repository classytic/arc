/**
 * Authentication registration for createApp.
 *
 * Extracted from createApp step 9: scope decoration, auth strategy,
 * elevation plugin, and error handler.
 */

import { isProductionEnv } from "@classytic/primitives/environment";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorHandlerOptions, ErrorMapper } from "../plugins/errorHandler.js";
import { PUBLIC_SCOPE } from "../scope/types.js";
import type { CreateAppOptions } from "./types/index.js";

type PluginTracker = (name: string, opts?: Record<string, unknown>) => void;

/**
 * Decorate request.scope with PUBLIC_SCOPE default.
 * Every request starts as public; auth hooks upgrade it.
 */
export function decorateRequestScope(fastify: FastifyInstance): void {
  // Initial value is `null` — the onRequest hook below sets the real
  // default (`PUBLIC_SCOPE`) per-request. Using `null` here, not the
  // public scope literal, avoids Fastify 5's reference-type sharing bug
  // (a single mutable scope object would otherwise be shared across
  // concurrent requests under high concurrency, since `decorateRequest`
  // copies the reference, not the value).
  //
  // Fastify's `decorateRequest` overload set narrows the value parameter
  // against the augmented `FastifyRequest.scope` shape and rejects raw
  // `null`. Reach the second-overload via the `as unknown as` cast — one
  // narrow, documented boundary instead of a non-null assertion at the
  // call site.
  (fastify.decorateRequest as unknown as (name: string, value: unknown) => void)("scope", null);
  fastify.addHook("onRequest", async (request) => {
    if (!request.scope) {
      request.scope = PUBLIC_SCOPE;
    }
  });
}

/**
 * Register the configured auth strategy (JWT, Better Auth, Custom, or Authenticator).
 */
export async function registerAuth(
  fastify: FastifyInstance,
  config: CreateAppOptions,
  trackPlugin: PluginTracker,
): Promise<void> {
  const authConfig = config.auth;
  if (authConfig === false || !authConfig) {
    fastify.log.debug("Authentication disabled");
    return;
  }

  switch (authConfig.type) {
    case "betterAuth": {
      // Thunk form (2.22) resolves HERE — after `beforeBoot` — so adapters
      // needing a live DB (BA's mongodbAdapter) never force hosts into
      // connect-before-createApp ordering.
      const adapter =
        typeof authConfig.betterAuth === "function"
          ? await authConfig.betterAuth()
          : authConfig.betterAuth;
      const { plugin, openapi } = adapter;
      await fastify.register(plugin);
      trackPlugin("auth-better-auth");
      // arcCorePlugin is registered earlier in registerArcPlugins → arc is live here.
      const arc = fastify.arc;
      if (arc && openapi && !arc.externalOpenApiPaths.includes(openapi)) {
        arc.externalOpenApiPaths.push(openapi);
      }
      fastify.log.debug("Better Auth authentication enabled");
      break;
    }
    case "custom": {
      await fastify.register(authConfig.plugin);
      trackPlugin("auth-custom");
      fastify.log.debug("Custom authentication plugin enabled");
      break;
    }
    case "authenticator": {
      const { authenticate, optionalAuthenticate } = authConfig;
      fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
        await authenticate(request, reply);
      });
      if (!fastify.hasDecorator("optionalAuthenticate")) {
        if (optionalAuthenticate) {
          fastify.decorate(
            "optionalAuthenticate",
            async (request: FastifyRequest, reply: FastifyReply) => {
              await optionalAuthenticate(request, reply);
            },
          );
        } else {
          fastify.decorate("optionalAuthenticate", createOptionalAuthenticate(authenticate));
        }
      }
      trackPlugin("auth-authenticator");
      fastify.log.debug("Custom authenticator enabled");
      break;
    }
    case "jwt": {
      const { authPlugin } = await import("../auth/index.js");
      const { type: _, ...arcAuthOpts } = authConfig;
      await fastify.register(authPlugin, arcAuthOpts);
      trackPlugin("auth-jwt");
      fastify.log.debug("Arc authentication plugin enabled");
      break;
    }
  }
}

/**
 * Register elevation plugin (opt-in, runs after auth).
 */
export async function registerElevation(
  fastify: FastifyInstance,
  config: CreateAppOptions,
  trackPlugin: PluginTracker,
): Promise<void> {
  if (!config.elevation) return;
  const { elevationPlugin } = await import("../scope/elevation.js");
  await fastify.register(elevationPlugin, config.elevation);
  trackPlugin("arc-elevation", config.elevation as Record<string, unknown>);
  fastify.log.debug("Elevation plugin enabled");
}

/**
 * Register error handler plugin (opt-out).
 *
 * `moduleErrorMappers` — mappers shipped by composed arc modules
 * (`defineModule({ errorMappers })`), appended AFTER host-declared mappers
 * so host config keeps priority. Collected by `createApp` from the
 * pre-resolved module graph.
 */
export async function registerErrorHandler(
  fastify: FastifyInstance,
  config: CreateAppOptions,
  trackPlugin: PluginTracker,
  moduleErrorMappers?: readonly ErrorMapper[],
): Promise<void> {
  if (config.errorHandler === false) return;
  const { errorHandlerPlugin } = await import("../plugins/errorHandler.js");

  /**
   * DISCLOSURE DEFAULTS MERGE — they used to be REPLACED, and that was two bugs.
   *
   * This was a ternary: an object from the host was used verbatim, otherwise
   * `{ includeStack: config.preset !== "production" }`. Both branches leaked.
   *
   *   1. A host that passed ANY key — even just `errorMappers` — lost the preset-derived
   *      `includeStack` and fell through to `errorHandlerPlugin`'s own default, which is
   *      `!(process.env.NODE_ENV === "production")`. That comparison knows only the long
   *      spelling, so under `NODE_ENV=prod` it yields `true` and stack traces ship to clients in
   *      production. Nobody writing `errorHandler: { errorMappers: [...] }` could reasonably
   *      expect it to change stack-trace exposure.
   *   2. The derived branch never set `exposeInternalMessages` AT ALL, so that switch fell
   *      through to the same raw read for EVERY arc app however it was configured. A truthy value
   *      is what skips `wire.message = "Internal Server Error"` for a 500, putting the raw thrown
   *      message — driver text, query fragments — on the wire.
   *
   * `preset` is the right source: it is the deployment's EXPLICIT declaration, and a specific
   * setting must never be overridden by an ambient default. Host keys still win over `derived`,
   * so an operator can widen deliberately; what they can no longer do is widen by accident.
   *
   *   3. And `preset` is OPTIONAL, so its ABSENCE must not read as "not production" either.
   *      `config.preset !== "production"` is true for an unset preset, and plenty of hosts set
   *      only `NODE_ENV` — which turns "the operator said nothing" into "the operator said
   *      development", the widest possible reading of silence, on the two switches where being
   *      wrong ships stack traces and raw driver text.
   *
   * So: an explicit `preset` wins; its absence falls back to the ENVIRONMENT rather than to a
   * guess; and that fallback goes through `isProductionEnv` from the shared classifier, never a raw
   * `process.env.NODE_ENV === "production"`. The raw form recognises only the long spelling, so a
   * preset-less host on `NODE_ENV=prod` read as non-production and re-opened both switches — the
   * same defect class this fallback exists to close, one layer in. Verified against a real 500 in
   * every state, including a Mongo connection string reaching the response body before the fix
   * (`tests/factory/error-disclosure-defaults.test.ts`).
   */
  const productionEnv =
    config.preset !== undefined
      ? config.preset === "production"
      : isProductionEnv(process.env.NODE_ENV);
  const derived: ErrorHandlerOptions = {
    includeStack: !productionEnv,
    exposeInternalMessages: !productionEnv,
  };
  let errorOpts: ErrorHandlerOptions =
    typeof config.errorHandler === "object" ? { ...derived, ...config.errorHandler } : derived;
  if (moduleErrorMappers && moduleErrorMappers.length > 0) {
    errorOpts = {
      ...errorOpts,
      errorMappers: [...(errorOpts.errorMappers ?? []), ...moduleErrorMappers],
    };
  }
  await fastify.register(errorHandlerPlugin, errorOpts);
  trackPlugin("arc-error-handler", errorOpts as Record<string, unknown>);
  fastify.log.debug("Arc error handler enabled");
}

// ── Internal ──

/**
 * Create an optionalAuthenticate that wraps the main authenticate function.
 * Intercepts 401/403 responses so unauthenticated requests proceed as public.
 *
 * Uses a try/catch approach first; falls back to reply proxy only when
 * the authenticator calls reply.code(401).send() instead of throwing.
 */
function createOptionalAuthenticate(
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let intercepted = false;
    const proxyReply = new Proxy(reply, {
      get(target, prop) {
        if (prop === "code") {
          return (statusCode: number) => {
            if (statusCode === 401 || statusCode === 403) {
              intercepted = true;
              return new Proxy(target, {
                get(_t, p) {
                  if (p === "send" || p === "type" || p === "header" || p === "headers") {
                    return () => proxyReply;
                  }
                  return Reflect.get(target, p, target);
                },
              });
            }
            return target.code(statusCode);
          };
        }
        if (prop === "send" && intercepted) {
          return () => proxyReply;
        }
        if (prop === "sent") {
          return intercepted ? false : target.sent;
        }
        return Reflect.get(target, prop, target);
      },
    });

    try {
      await authenticate(request, proxyReply as FastifyReply);
    } catch {
      // Silently ignore auth errors — treat as unauthenticated
    }
  };
}
