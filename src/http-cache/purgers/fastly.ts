/**
 * Fastly surrogate-key purge, with soft purge (`Fastly-Soft-Purge: 1`). Responses must carry the tags in
 * `Surrogate-Key`, space-separated: register the plugin with `tagHeader: { name: 'Surrogate-Key', separator: ' ' }`.
 * Fastly accepts 256 keys per bulk call. Failures throw `CachePurgeError`, never the API key.
 */
import { CachePurgeError, type CachePurger } from "./purger.types.js";

export interface FastlyPurgerOptions {
  serviceId: string;
  apiKey: string;
  /** Keys per call. Default 256 (Fastly's bulk limit). */
  maxTagsPerCall?: number;
  fetch?: typeof fetch;
  /** Default `https://api.fastly.com`. */
  apiBase?: string;
}

export function createFastlyPurger(options: FastlyPurgerOptions): CachePurger {
  if (!options.serviceId?.trim())
    throw new Error("[arc] createFastlyPurger: serviceId is required");
  if (!options.apiKey?.trim()) throw new Error("[arc] createFastlyPurger: apiKey is required");
  const size = options.maxTagsPerCall ?? 256;
  if (!Number.isInteger(size) || size < 1)
    throw new Error("[arc] createFastlyPurger: maxTagsPerCall must be a positive integer");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function")
    throw new Error("[arc] createFastlyPurger: no fetch implementation available");
  const url = `${options.apiBase ?? "https://api.fastly.com"}/service/${encodeURIComponent(options.serviceId)}/purge`;

  return {
    name: "fastly",
    capabilities: { softPurge: true, maxTagsPerCall: size },
    async purgeTags(tags, { mode }) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            "fastly-key": options.apiKey,
            "content-type": "application/json",
            accept: "application/json",
            ...(mode === "soft" ? { "fastly-soft-purge": "1" } : {}),
          },
          body: JSON.stringify({ surrogate_keys: tags }),
        });
      } catch {
        throw new CachePurgeError("fastly", "Fastly purge request could not be sent");
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as
          | { msg?: string; detail?: string }
          | undefined;
        const code = typeof body?.msg === "string" ? [body.msg] : [];
        throw new CachePurgeError(
          "fastly",
          `Fastly purge refused (HTTP ${res.status})`,
          res.status,
          code,
        );
      }
    },
  };
}
