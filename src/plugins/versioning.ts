/**
 * API Version Detection Plugin
 *
 * Detects the client-requested API version (header or URL prefix), stamps
 * `request.apiVersion` + a response header, enforces a supported-version
 * list, and signals deprecation (`Deprecation` / `Sunset` headers).
 *
 * ## What this plugin is NOT
 *
 * It does **not** route requests to version-specific handlers or schemas —
 * every version reaches the same route. Version *routing* is a composition
 * concern, and the canonical Fastify answers are:
 *
 *   - **Prefix routing** — register version scopes:
 *     `app.register(v1Routes, { prefix: '/v1' })` /
 *     `app.register(v2Routes, { prefix: '/v2' })`. Each scope carries its
 *     own schemas and OpenAPI contract.
 *   - **Constraint routing** — Fastify's built-in `constraints: { version }`
 *     per route for header-negotiated versioning.
 *
 * Use this plugin for the cross-cutting envelope (detection, rejection of
 * unsupported versions, deprecation signaling) and one of the mechanisms
 * above when handlers/schemas genuinely diverge between versions.
 *
 * @example
 * ```typescript
 * // Header-based: clients send Accept-Version: 2
 * await fastify.register(versioningPlugin, { type: 'header' });
 *
 * // Reject anything outside the supported set with 400
 * await fastify.register(versioningPlugin, {
 *   type: 'header',
 *   versions: ['1', '2'],
 * });
 *
 * // With deprecation warnings
 * await fastify.register(versioningPlugin, {
 *   type: 'header',
 *   versions: ['1', '2'],
 *   deprecated: ['1'],
 *   sunset: '2025-06-01',
 * });
 * ```
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { createDomainError } from "../utils/errors.js";

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
  /**
   * Supported versions. When set, a request for any OTHER version is
   * rejected with `400 arc.unsupported_api_version` (details list the
   * supported set). When omitted, every requested version is accepted
   * and merely annotated — detection-only mode.
   *
   * The `defaultVersion` must be in this list (boot-time check) so a
   * versionless request can never be rejected by its own default.
   */
  versions?: string[];
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
    versions,
    deprecated = [],
    sunset,
  } = opts;

  const deprecatedSet = new Set(deprecated);
  const supportedSet = versions ? new Set(versions) : undefined;

  // Boot-time config sanity: the default must be servable, otherwise every
  // versionless request would 400 against the host's own configuration.
  if (supportedSet && !supportedSet.has(defaultVersion)) {
    throw new Error(
      `versioningPlugin: defaultVersion '${defaultVersion}' is not in versions [${[...supportedSet].join(", ")}]`,
    );
  }

  fastify.decorateRequest("apiVersion", defaultVersion);

  // Resolve version + queue response headers in a SINGLE onRequest hook.
  //
  // The reply.header() calls are intentionally in onRequest, NOT onSend.
  // An async onSend hook races with Fastify's onSendEnd → safeWriteHead
  // path and produces ERR_HTTP_HEADERS_SENT unhandled rejections for
  // slow responses. Other arc plugins dodge the same race class via
  // different mechanisms — requestId also uses onRequest (static
  // header), caching uses preSerialization (needs payload). Versioning
  // fits the requestId pattern: the version is derived entirely from
  // the request, so onRequest is strictly better than any later hook.
  // Fires for every response including 204 / streams where
  // preSerialization would be skipped.
  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
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

    // Reject unsupported versions BEFORE annotating the reply — a client
    // asking for v99 gets a contract error, not a silent fallthrough to
    // whatever handler happens to be mounted.
    if (supportedSet && !supportedSet.has(version)) {
      throw createDomainError(
        "arc.unsupported_api_version",
        `API version '${version}' is not supported`,
        400,
        { requested: version, supported: [...supportedSet] },
      );
    }

    request.apiVersion = version;
    reply.header(responseHeader, version);

    if (deprecatedSet.has(version)) {
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
