/**
 * Security & performance plugin registration for createApp.
 *
 * Extracted from createApp steps 4–6:
 * - Helmet (security headers)
 * - CORS (cross-origin requests)
 * - Rate limiting (DDoS protection)
 * - Under Pressure (health monitoring)
 * - Sensible (HTTP helpers)
 * - Multipart (file uploads)
 * - Raw body (webhooks)
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FastifyPlugin } from "./shared.js";
import type { CreateAppOptions } from "./types.js";

type RateLimitAllowList =
  | string[]
  | ((req: FastifyRequest, key: string) => boolean | Promise<boolean>);

/**
 * Translate `skipPaths` sugar into a `@fastify/rate-limit` `allowList`
 * function. A user-supplied `allowList` (array of IPs or function) is
 * preserved and OR-ed with the path match.
 */
function buildRateLimitOpts(input: Record<string, unknown>): Record<string, unknown> {
  const { skipPaths, allowList, ...rest } = input as Record<string, unknown> & {
    skipPaths?: string[];
    allowList?: RateLimitAllowList;
  };

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

// Plugin registry: name → { package, loader, optional }
const PLUGIN_REGISTRY: Record<
  string,
  {
    package: string;
    loader: () => Promise<FastifyPlugin>;
    optional?: boolean;
  }
> = {
  cors: {
    package: "@fastify/cors",
    loader: () => import("@fastify/cors").then((m) => m.default),
  },
  helmet: {
    package: "@fastify/helmet",
    loader: () => import("@fastify/helmet").then((m) => m.default),
  },
  rateLimit: {
    package: "@fastify/rate-limit",
    loader: () => import("@fastify/rate-limit").then((m) => m.default),
  },
  underPressure: {
    package: "@fastify/under-pressure",
    loader: () => import("@fastify/under-pressure").then((m) => m.default),
  },
  sensible: {
    package: "@fastify/sensible",
    loader: () => import("@fastify/sensible").then((m) => m.default),
  },
  multipart: {
    package: "@fastify/multipart",
    loader: () => import("@fastify/multipart").then((m) => m.default),
    optional: true,
  },
  rawBody: {
    package: "fastify-raw-body",
    loader: () => import("fastify-raw-body").then((m) => m.default),
    optional: true,
  },
};

/** Load a plugin from the registry with helpful error messages. */
export async function loadPlugin(
  name: string,
  logger?: { warn: (msg: string) => void },
): Promise<FastifyPlugin | null> {
  const entry = PLUGIN_REGISTRY[name];
  if (!entry) {
    throw new Error(`Unknown plugin: ${name}`);
  }

  try {
    return await entry.loader();
  } catch (error) {
    const err = error as Error;
    const isModuleNotFound =
      err.message.includes("Cannot find module") ||
      err.message.includes("Cannot find package") ||
      err.message.includes("MODULE_NOT_FOUND") ||
      err.message.includes("Could not resolve");

    if (isModuleNotFound && entry.optional) {
      logger?.warn(`Optional plugin '${name}' skipped (${entry.package} not installed)`);
      return null;
    }

    if (isModuleNotFound) {
      throw new Error(
        `Plugin '${name}' requires package '${entry.package}' which is not installed.\n` +
          `Install it with: npm install ${entry.package}\n` +
          `Or disable this plugin by setting ${name}: false in createApp options.`,
      );
    }

    throw new Error(`Failed to load plugin '${name}': ${err.message}`);
  }
}

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
    const helmet = (await loadPlugin("helmet"))!;
    await fastify.register(helmet, (config.helmet ?? {}) as Record<string, unknown>);
    fastify.log.debug("Helmet (security headers) enabled");
  } else {
    fastify.log.warn("Helmet disabled - security headers not applied");
  }

  // CORS — cross-origin requests
  if (config.cors !== false) {
    const cors = (await loadPlugin("cors"))!;
    const corsOptions = { ...(config.cors ?? {}) } as Record<string, unknown>;

    // Production CORS warning — also catches the env-derived `undefined`
    // hazard. The canonical README pattern was
    //   `cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') }`
    // which evaluates to `{ origin: undefined }` when the env var is unset
    // — `'origin' in corsOptions` would be `true`, so the pre-2.11.3 check
    // skipped the warning and `@fastify/cors` quietly fell back to its
    // default (no Access-Control-Allow-Origin header set), which behaves
    // differently across browsers and looks like silent CORS misconfig.
    // Treat `origin: undefined` the same as missing.
    const originDeclared = "origin" in corsOptions && corsOptions.origin !== undefined;
    if (config.preset === "production" && !originDeclared) {
      fastify.log.warn(
        "CORS origin is not explicitly configured in production. " +
          "Browser apps: set cors.origin to allowed domains (e.g. ['https://app.example.com']) " +
          "with credentials: true. Server-to-server / API-key services: " +
          "cors: { origin: '*', credentials: false } OR cors: false to disable. " +
          "Tip: when wiring cors.origin from an env var, fail fast on missing " +
          "(`if (!process.env.ALLOWED_ORIGINS) throw ...`) instead of letting " +
          "`undefined` slip through.",
      );
    }

    // Smart CORS: credentials + origin:'*' → origin:true (reflect Origin header)
    if (corsOptions.credentials && corsOptions.origin === "*") {
      corsOptions.origin = true;
    }

    await fastify.register(cors, corsOptions);
    fastify.log.debug("CORS enabled");
  } else {
    fastify.log.warn("CORS disabled");
  }

  // Rate limiting — DDoS protection
  if (config.rateLimit !== false) {
    const rateLimit = (await loadPlugin("rateLimit"))!;
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
    const underPressure = (await loadPlugin("underPressure"))!;
    await fastify.register(underPressure, config.underPressure ?? { exposeStatusRoute: true });
    fastify.log.debug("Health monitoring (under-pressure) enabled");
  }

  // Sensible — HTTP helpers
  if (config.sensible !== false) {
    const sensible = (await loadPlugin("sensible"))!;
    await fastify.register(sensible);
    fastify.log.debug("Sensible (HTTP helpers) enabled");
  }

  // Multipart — file uploads (optional dep)
  if (config.multipart !== false) {
    const multipart = await loadPlugin("multipart", fastify.log);
    if (multipart) {
      await fastify.register(multipart, {
        limits: { fileSize: 10 * 1024 * 1024, files: 10 },
        throwFileSizeLimit: true,
        ...config.multipart,
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
