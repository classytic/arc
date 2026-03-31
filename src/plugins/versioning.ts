/**
 * API Versioning Plugin
 *
 * Supports header-based and URL prefix-based versioning.
 *
 * @example
 * ```typescript
 * // Header-based: clients send Accept-Version: 2
 * await fastify.register(versioningPlugin, { type: 'header' });
 *
 * // Prefix-based: routes under /v2/...
 * await fastify.register(versioningPlugin, { type: 'prefix' });
 *
 * // With deprecation warnings
 * await fastify.register(versioningPlugin, {
 *   type: 'header',
 *   deprecated: ['1'],
 *   sunset: '2025-06-01',
 * });
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

// ============================================================================
// Types
// ============================================================================

export interface VersioningOptions {
  /** Versioning strategy */
  type: "header" | "prefix";
  /** Default version when none specified (default: '1') */
  defaultVersion?: string;
  /** Header name to read (default: 'accept-version') */
  headerName?: string;
  /** Response header name (default: 'x-api-version') */
  responseHeader?: string;
  /** Deprecated versions — adds Deprecation + Sunset headers */
  deprecated?: string[];
  /** Sunset date for deprecated versions (ISO 8601) */
  sunset?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    apiVersion: string;
  }
}

// ============================================================================
// Plugin
// ============================================================================

const PREFIX_REGEX = /^\/v(\d+)\//;

const versioningPlugin: FastifyPluginAsync<VersioningOptions> = async (
  fastify: FastifyInstance,
  opts: VersioningOptions,
) => {
  const {
    type,
    defaultVersion = "1",
    headerName = "accept-version",
    responseHeader = "x-api-version",
    deprecated = [],
    sunset,
  } = opts;

  const deprecatedSet = new Set(deprecated);

  fastify.decorateRequest("apiVersion", defaultVersion);

  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    let version = defaultVersion;

    if (type === "header") {
      const headerValue = request.headers[headerName];
      if (headerValue) {
        version = String(headerValue);
      }
    } else if (type === "prefix") {
      const match = request.url.match(PREFIX_REGEX);
      if (match) {
        version = match[1] ?? defaultVersion;
      }
    }

    request.apiVersion = version;
  });

  fastify.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header(responseHeader, request.apiVersion);

    if (deprecatedSet.has(request.apiVersion)) {
      reply.header("deprecation", "true");
      reply.header(
        "sunset",
        sunset ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
  });
};

export default fp(versioningPlugin, {
  name: "arc-versioning",
  fastify: "5.x",
});

export { versioningPlugin };
