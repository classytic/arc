import { type CachePurger, chunkTags, type PurgeMode } from "./purger.types.js";

/** Purges nothing: the default for development and tests. */
export const noopPurger: CachePurger = { name: "noop", purgeTags: async () => {} };

/** Records every call: assert purges in tests without a CDN. */
export function createMemoryPurger(capabilities?: CachePurger["capabilities"]) {
  const calls: Array<{ tags: string[]; mode: PurgeMode }> = [];
  const purger: CachePurger = {
    name: "memory",
    ...(capabilities ? { capabilities } : {}),
    purgeTags: async (tags, { mode }) => {
      calls.push({ tags: [...tags], mode });
    },
  };
  return { purger, calls };
}

/**
 * Purge several tiers at once (CDN + in-process + a second CDN). Each child gets its own chunking and
 * soft-purge support; all are attempted, and any failure rejects with every error.
 */
export function composePurgers(...purgers: readonly CachePurger[]): CachePurger {
  if (!purgers.length) throw new Error("[arc] composePurgers needs at least one purger");
  return {
    name: `compose(${purgers.map((p) => p.name).join(",")})`,
    capabilities: { softPurge: true },
    async purgeTags(tags, { mode }) {
      const results = await Promise.allSettled(
        purgers.map(async (p) => {
          const childMode: PurgeMode =
            mode === "soft" && p.capabilities?.softPurge ? "soft" : "hard";
          for (const chunk of chunkTags(tags, p.capabilities?.maxTagsPerCall))
            await p.purgeTags(chunk, { mode: childMode });
        }),
      );
      const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      if (errors.length)
        throw new AggregateError(errors, `${errors.length} of ${purgers.length} purgers failed`);
    },
  };
}
