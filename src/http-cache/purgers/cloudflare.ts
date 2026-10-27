/**
 * Cloudflare purge-by-tag (`Cache-Tag`). Needs an API token scoped to Zone > Cache Purge only.
 *
 * Cloudflare has no soft purge by tag, so soft purges are sent hard. 30 tags per call is the
 * free-plan-safe default. Failures throw `CachePurgeError` with Cloudflare's error codes, never the token.
 */
import { CachePurgeError, type CachePurger } from "./purger.types.js";

export interface CloudflarePurgerOptions {
  zoneId: string;
  apiToken: string;
  /** Tags per API call. Default 30. */
  maxTagsPerCall?: number;
  /** Injected for tests and other runtimes. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Default `https://api.cloudflare.com/client/v4`. */
  apiBase?: string;
}

export function createCloudflarePurger(options: CloudflarePurgerOptions): CachePurger {
  if (!options.zoneId?.trim()) throw new Error("[arc] createCloudflarePurger: zoneId is required");
  if (!options.apiToken?.trim())
    throw new Error("[arc] createCloudflarePurger: apiToken is required");
  const size = options.maxTagsPerCall ?? 30;
  if (!Number.isInteger(size) || size < 1)
    throw new Error("[arc] createCloudflarePurger: maxTagsPerCall must be a positive integer");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function")
    throw new Error("[arc] createCloudflarePurger: no fetch implementation available");
  const url = `${options.apiBase ?? "https://api.cloudflare.com/client/v4"}/zones/${encodeURIComponent(options.zoneId)}/purge_cache`;

  return {
    name: "cloudflare",
    capabilities: { softPurge: false, maxTagsPerCall: size },
    async purgeTags(tags) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tags }),
        });
      } catch {
        throw new CachePurgeError("cloudflare", "Cloudflare purge request could not be sent");
      }
      const body = (await res.json().catch(() => undefined)) as
        | { success?: boolean; errors?: Array<{ code?: number }> }
        | undefined;
      if (!res.ok || body?.success !== true) {
        const codes = (body?.errors ?? [])
          .map((e) => e.code)
          .filter((c): c is number => typeof c === "number");
        throw new CachePurgeError(
          "cloudflare",
          `Cloudflare purge refused (HTTP ${res.status})`,
          res.status,
          codes,
        );
      }
    },
  };
}
