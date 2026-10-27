import type { FastifyRequest } from "fastify";
import type { PrivacyDecision } from "./policy.types.js";

export const DEFAULT_PRIVATE_HEADERS = ["authorization", "x-api-key", "x-organization-id"] as const;

export interface PrivacyOptions {
  /** Request headers that make a request private. Default {@link DEFAULT_PRIVATE_HEADERS}. */
  privateHeaders?: readonly string[];
  /** Cookie names that do NOT make a request private (analytics, consent). Any other cookie does. */
  publicCookies?: readonly string[];
  /** Extra check, AND-ed with the built-in one: return false to make a request private. Never makes one public. */
  classify?: (request: FastifyRequest) => boolean;
}

function cookieNames(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const value = Array.isArray(header) ? header.join(";") : header;
  return value
    .split(";")
    .map((part) => part.split("=")[0]?.trim() ?? "")
    .filter(Boolean);
}

/**
 * Private when ANY signal of a caller is present: a credential header, a cookie outside the allowlist, a
 * non-public arc scope, or the host's classifier. Reasons name the signal, never its value.
 */
export function classifyPrivacy(
  request: FastifyRequest,
  opts: PrivacyOptions = {},
): PrivacyDecision {
  const headers = request.headers;
  for (const name of opts.privateHeaders ?? DEFAULT_PRIVATE_HEADERS) {
    const key = name.toLowerCase();
    if (headers[key] !== undefined) return { private: true, reason: `header:${key}` };
  }
  const allowed = new Set(opts.publicCookies ?? []);
  const cookie = cookieNames(headers.cookie).find((name) => !allowed.has(name));
  if (cookie) return { private: true, reason: `cookie:${cookie}` };
  const scope = (request as FastifyRequest & { scope?: { kind?: string } }).scope;
  if (scope?.kind !== undefined && scope.kind !== "public") {
    return { private: true, reason: `scope:${scope.kind}` };
  }
  if (opts.classify && !opts.classify(request)) return { private: true, reason: "classifier" };
  return { private: false };
}
