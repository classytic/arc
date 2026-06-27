/**
 * Directive resolution — decide whether (and how) to encrypt a response.
 *
 * Precedence (highest first):
 *   1. Per-resource `extensions.encryption` (declarative, colocated with the
 *      resource), read from `request.routeOptions.config.arcExtensions`.
 *   2. Plugin-level `routes(request)` fallback matcher.
 *   3. Otherwise: no encryption.
 *
 * An explicit `enabled: false` on a resource directive is an authoritative
 * opt-out — it wins even when the `routes` matcher would include the route.
 */

import type { FastifyRequest } from "fastify";
import type { EncryptionDirective, EncryptionMode, ResolvedDirective } from "./types.js";

function routeDirective(request: FastifyRequest): EncryptionDirective | undefined {
  const config = request.routeOptions?.config as
    | { arcExtensions?: { encryption?: EncryptionDirective } }
    | undefined;
  return config?.arcExtensions?.encryption;
}

function finalize(
  directive: EncryptionDirective,
  defaultMode: EncryptionMode,
): ResolvedDirective | null {
  if (directive.enabled === false) return null;
  return {
    mode: directive.mode ?? defaultMode,
    fields: directive.fields ?? [],
  };
}

/**
 * Resolve the active directive for a request, or `null` to skip encryption.
 *
 * @param request     incoming request (carries route config)
 * @param defaultMode plugin-level default mode
 * @param fallback    plugin-level `routes` matcher (optional)
 */
export function resolveDirective(
  request: FastifyRequest,
  defaultMode: EncryptionMode,
  fallback?: (request: FastifyRequest) => EncryptionDirective | boolean | undefined,
): ResolvedDirective | null {
  // 1. Per-resource declaration wins — including an explicit opt-out.
  const declared = routeDirective(request);
  if (declared) return finalize(declared, defaultMode);

  // 2. Plugin-level fallback matcher.
  if (fallback) {
    const result = fallback(request);
    if (result === true) return { mode: defaultMode, fields: [] };
    if (result && typeof result === "object") return finalize(result, defaultMode);
  }

  // 3. No directive.
  return null;
}
