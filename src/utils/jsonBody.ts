/**
 * Shared JSON request-body parsing for every arc content-type parser
 * (`application/json`, `application/scim+json`, decrypted `application/jose`).
 *
 * One primitive, one contract:
 *   - empty body → `undefined` (DELETE/GET with `Content-Type: application/json`
 *     must not crash — the original reason arc replaces Fastify's parser)
 *   - prototype-poisoning payloads (`__proto__`, `constructor.prototype`)
 *     rejected via `secure-json-parse`, same protection Fastify's stock
 *     parser has
 *   - ANY parse failure → `ArcError` with `statusCode: 400` /
 *     `code: 'arc.bad_request'`. Client-sent bytes can never produce a 500:
 *     Fastify forwards parser errors to the error handler as-is, so an
 *     undecorated `SyntaxError` would fall through to the
 *     `arc.internal_error` fallback. The raw parser message stays on
 *     `cause` (logged, never on the wire).
 */

import sjp from "secure-json-parse";
import { ArcError } from "./errors.js";

/**
 * Parse a JSON request body with prototype-poisoning protection and the
 * arc 400 error contract.
 *
 * @param raw     - Body text (string or Buffer). Empty/absent → `undefined`.
 * @param message - Wire-safe error message for parse failures
 *                  (default: `"Invalid JSON payload"`).
 */
export function parseJsonBody(
  raw: string | Buffer | undefined | null,
  message = "Invalid JSON payload",
): unknown {
  const text = typeof raw === "string" ? raw : raw ? raw.toString("utf8") : "";
  if (text.length === 0) return undefined;
  try {
    return sjp.parse(text);
  } catch (cause) {
    throw new ArcError(message, {
      code: "arc.bad_request",
      statusCode: 400,
      cause: cause as Error,
    });
  }
}
