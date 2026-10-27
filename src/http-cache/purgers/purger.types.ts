/** `hard` evicts; `soft` marks stale so the next visitor gets the old copy while one request refreshes it. */
export type PurgeMode = "hard" | "soft";

export interface PurgerCapabilities {
  /** The vendor can mark content stale instead of evicting it. Absent: soft purges are sent hard. */
  readonly softPurge?: boolean;
  /** Tags per call. arc splits larger batches; each chunk is delivered (and retried) on its own. */
  readonly maxTagsPerCall?: number;
}

/** Purges cached responses by tag. Throws on failure: arc logs, counts, and (durably) retries. */
export interface CachePurger {
  readonly name: string;
  readonly capabilities?: PurgerCapabilities;
  purgeTags(tags: readonly string[], options: { mode: PurgeMode }): Promise<void>;
}

/** A purge the CDN refused or never answered: a closed code plus the provider's own codes, never a credential. */
export class CachePurgeError extends Error {
  readonly code = "http_cache.purge_failed";
  readonly purger: string;
  readonly status: number | undefined;
  readonly providerCodes: readonly (number | string)[];
  constructor(
    purger: string,
    message: string,
    status?: number,
    providerCodes: readonly (number | string)[] = [],
  ) {
    super(message);
    this.name = "CachePurgeError";
    this.purger = purger;
    this.status = status;
    this.providerCodes = providerCodes;
  }
}

/** Split tags into calls of at most `size`. */
export function chunkTags(tags: readonly string[], size: number | undefined): string[][] {
  if (!size || size >= tags.length) return [[...tags]];
  const out: string[][] = [];
  for (let i = 0; i < tags.length; i += size) out.push(tags.slice(i, i + size));
  return out;
}
