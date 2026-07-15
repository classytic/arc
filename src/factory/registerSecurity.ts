/**
 * Security & performance plugin registration for createApp — the
 * ORCHESTRATOR. Decides which plugins register, in which order, and how
 * warnings surface. The policies and pure option-building live in
 * `./security/` so each is unit-testable without a Fastify instance:
 *
 *   - `security/pluginLoader.ts` — optional-dep registry + loader
 *   - `security/cors.ts`         — CORS policy (prod-origin warning,
 *     wildcard+credentials boot throw, arc header merges, preflight cache)
 *   - `security/rateLimit.ts`    — `plan` / `skipPaths` sugar →
 *     @fastify/rate-limit primitives
 *
 * Registration order (helmet → cors → rate-limit → utility) is load-
 * bearing and stays here.
 */

import type { FastifyInstance } from "fastify";
import { resolveCorsOptions } from "./security/cors.js";
import { loadPlugin } from "./security/pluginLoader.js";
import { buildRateLimitOpts } from "./security/rateLimit.js";
import type { CreateAppOptions } from "./types/index.js";

// Re-exported from this module's historical home — createApp, registerArcPlugins,
// and host code import the loader from here.
export { loadPlugin };

/**
 * Register security plugins (Helmet, CORS, Rate Limiting).
 * All enabled by default — set to `false` to opt out.
 */
export async function registerSecurityPlugins(
  fastify: FastifyInstance,
  config: CreateAppOptions,
): Promise<void> {
  // Helmet — security headers
  if (config.helmet !== false) {
    const helmet = await loadPlugin("helmet");
    await fastify.register(helmet, (config.helmet ?? {}) as Record<string, unknown>);
    fastify.log.debug("Helmet (security headers) enabled");
  } else {
    fastify.log.warn("Helmet disabled - security headers not applied");
  }

  // CORS — cross-origin requests. ALL policy (prod-origin warning, the
  // wildcard+credentials boot throw, arc protocol/exposed header merges,
  // preflight max-age default) lives in security/cors.ts as a pure function.
  if (config.cors !== false) {
    const cors = await loadPlugin("cors");
    const { options: corsOptions, warnings } = resolveCorsOptions(config);
    for (const warning of warnings) {
      fastify.log.warn(warning);
    }
    await fastify.register(cors, corsOptions);
    fastify.log.debug("CORS enabled");
  } else {
    fastify.log.warn("CORS disabled");
  }

  // Rate limiting — DDoS protection
  if (config.rateLimit !== false) {
    const rateLimit = await loadPlugin("rateLimit");
    const rateLimitOpts = buildRateLimitOpts(
      config.rateLimit ?? { max: 100, timeWindow: "1 minute" },
    );
    await fastify.register(rateLimit, rateLimitOpts);

    const hasStore = typeof rateLimitOpts === "object" && "store" in rateLimitOpts;
    if (!hasStore) {
      if (config.runtime === "distributed") {
        throw new Error(
          "[Arc] runtime: 'distributed' with rate limiting requires a shared store.\n" +
            "Provide rateLimit: { store: new RedisStore({ ... }) } or disable rate limiting: rateLimit: false",
        );
      } else if (config.preset === "production") {
        fastify.log.warn(
          "Rate limiting is using in-memory store. In multi-instance deployments, " +
            "each instance tracks limits independently. Configure a Redis store for distributed rate limiting.",
        );
      }
    }

    fastify.log.debug("Rate limiting enabled");
  } else {
    fastify.log.warn("Rate limiting disabled");
  }
}

/**
 * Register performance and utility plugins (Under Pressure, Sensible, Multipart, Raw Body).
 */
export async function registerUtilityPlugins(
  fastify: FastifyInstance,
  config: CreateAppOptions,
): Promise<void> {
  // Compression warning — only for production
  if (config.preset === "production") {
    fastify.log.warn(
      "Response compression is not enabled (Fastify 5 stream issues). " +
        "Use a reverse proxy (Nginx, Caddy, Cloudflare) for gzip/brotli in production.",
    );
  }

  // Under Pressure — health monitoring
  if (config.underPressure !== false) {
    const underPressure = await loadPlugin("underPressure");
    await fastify.register(underPressure, config.underPressure ?? { exposeStatusRoute: true });
    fastify.log.debug("Health monitoring (under-pressure) enabled");
  }

  // Sensible — HTTP helpers
  if (config.sensible !== false) {
    const sensible = await loadPlugin("sensible");
    await fastify.register(sensible);
    fastify.log.debug("Sensible (HTTP helpers) enabled");
  }

  // Multipart — file uploads (optional dep)
  if (config.multipart !== false) {
    const multipart = await loadPlugin("multipart", fastify.log);
    if (multipart) {
      // Busboy defaults `fields` and `parts` to Infinity — an unauthenticated
      // multipart body with millions of tiny fields is a memory/CPU
      // amplification vector even with fileSize capped. Cap every dimension;
      // hosts override per key (limits are DEEP-merged so overriding
      // `fileSize` doesn't silently drop the `fields`/`parts` caps).
      const hostMultipart =
        typeof config.multipart === "object" && config.multipart !== null
          ? (config.multipart as Record<string, unknown> & {
              limits?: Record<string, unknown>;
            })
          : {};
      await fastify.register(multipart, {
        throwFileSizeLimit: true,
        ...hostMultipart,
        limits: {
          fileSize: 10 * 1024 * 1024,
          files: 10,
          fields: 100,
          parts: 120, // files + fields + slack
          ...hostMultipart.limits,
        },
      });
      fastify.log.debug("Multipart (file uploads) enabled");
    }
  }

  // Raw body — webhooks (optional dep)
  if (config.rawBody !== false) {
    const rawBody = await loadPlugin("rawBody", fastify.log);
    if (rawBody) {
      await fastify.register(rawBody, {
        field: "rawBody",
        global: false,
        encoding: "utf8",
        runFirst: true,
        ...config.rawBody,
      });
      fastify.log.debug("Raw body parsing enabled");
    }
  }
}
