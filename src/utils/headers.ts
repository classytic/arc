/**
 * Canonical header typing + accessor.
 *
 * Node/Fastify header values are `string | string[] | undefined` — repeated
 * headers arrive as arrays. `IRequestContext.headers` is DECLARED as
 * `Record<string, string | undefined>` for ergonomic host code, but the HTTP
 * adapter passes Fastify's headers object through unchanged, so `string[]`
 * CAN appear at runtime behind the narrower type (the declared type is
 * scheduled to widen to {@link ArcHeaders} in v3). Until then, read headers
 * through {@link getHeader} instead of indexing — it's honest about arrays
 * and deterministic about duplicates.
 */

import { ValidationError } from "./errors.js";

/** What a headers bag actually contains at runtime — HTTP or synthetic MCP. */
export type ArcHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Read a single header value. Lowercases the name (Node normalizes incoming
 * header names to lowercase) and returns the FIRST value when the header
 * was repeated.
 *
 * Duplicate policy: first-value is deterministic, but for security-sensitive
 * headers (authorization material, forwarded-for chains, content-length) a
 * duplicate usually signals smuggling or a broken proxy — consumers that
 * care should check `Array.isArray(headers[name])` and REJECT instead of
 * picking a winner.
 */
export function getHeader(
  headers: ArcHeaders | Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const value = (headers as ArcHeaders)[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value as string | undefined;
}

/**
 * Read an identity-bearing or protocol header and reject repeated values.
 *
 * Repeated security-sensitive headers are ambiguous at proxy boundaries and
 * may indicate request smuggling. Callers must not silently choose a winner.
 */
export function requireSingleHeaderValue(
  headers: ArcHeaders | Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const value = (headers as ArcHeaders)[name.toLowerCase()];
  if (Array.isArray(value)) {
    throw new ValidationError(`Duplicate '${name}' header`);
  }
  return value as string | undefined;
}
