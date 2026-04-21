/**
 * Authentication registration for createApp.
 *
 * Extracted from createApp step 9: scope decoration, auth strategy,
 * elevation plugin, and error handler.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PUBLIC_SCOPE } from "../scope/types.js";
import type { CreateAppOptions } from "./types.js";

type PluginTracker = (name: string, opts?: Record<string, unknown>) => void;

/**
 * Decorate request.scope with PUBLIC_SCOPE default.
 * Every request starts as public; auth hooks upgrade it.
 */
export function decorateRequestScope(fastify: FastifyInstance): void {
  // Initial value is null — the onRequest hook sets the real default per-request.
  // Using null avoids Fastify 5's reference-type sharing bug.
  fastify.decorateRequest("scope", null!);
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
      const { plugin, openapi } = authConfig.betterAuth;
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
 */
export async function registerErrorHandler(
  fastify: FastifyInstance,
  config: CreateAppOptions,
  trackPlugin: PluginTracker,
): Promise<void> {
  if (config.errorHandler === false) return;
  const { errorHandlerPlugin } = await import("../plugins/errorHandler.js");
  const errorOpts =
    typeof config.errorHandler === "object"
      ? config.errorHandler
      : { includeStack: config.preset !== "production" };
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
