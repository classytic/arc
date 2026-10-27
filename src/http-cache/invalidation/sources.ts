import type { FastifyInstance } from "fastify";
import type { DomainEvent } from "../../events/EventTransport.js";
import { hasEvents } from "../../utils/typeGuards.js";
import type { DocumentTags } from "../policy/policy.types.js";
import { resourceTags } from "../policy/tags.js";
import type { PurgeMode } from "../purgers/purger.types.js";
import type { Invalidator } from "./invalidator.js";

/** Event pattern -> tags (purged hard), or `{ tags, mode }` to choose the mode. */
export type PurgeOn = Readonly<
  Record<
    string,
    (
      event: DomainEvent<unknown>,
    ) => readonly string[] | { tags: readonly string[]; mode: PurgeMode } | undefined
  >
>;

const SUFFIX_MODE: Record<string, PurgeMode> = {
  created: "soft",
  updated: "soft",
  deleted: "hard",
};

/**
 * The tags a CRUD event invalidates for a cached resource: `<resource>` (its lists) and `<resource>:<id>`,
 * plus the resource's extra tags for the document. Updates and creates purge soft (stale copy served while
 * one request refreshes); deletes purge hard.
 */
export function tagsForCrudEvent(
  event: DomainEvent<unknown>,
  resources: ReadonlyMap<string, { extra?: DocumentTags }>,
): { tags: string[]; mode: PurgeMode } | undefined {
  const dot = event.type.lastIndexOf(".");
  if (dot === -1) return undefined;
  const mode = SUFFIX_MODE[event.type.slice(dot + 1)];
  if (!mode) return undefined;
  const meta = event.meta as { resource?: unknown; resourceId?: unknown };
  const qualified = typeof meta.resource === "string" ? meta.resource : event.type.slice(0, dot);
  const bare = qualified.includes(":")
    ? qualified.slice(qualified.lastIndexOf(":") + 1)
    : qualified;
  const name = resources.has(qualified) ? qualified : resources.has(bare) ? bare : undefined;
  if (!name) return undefined;
  const tags = resourceTags(name, meta.resourceId);
  const extra = resources.get(name)?.extra;
  if (extra) tags.push(...(extra((event.payload as { data?: unknown } | undefined)?.data) ?? []));
  return { tags, mode };
}

/** Subscribe the invalidator to resource CRUD events (automatic) and to explicit `purgeOn` patterns. */
export async function wireInvalidationSources(
  fastify: FastifyInstance,
  opts: {
    invalidator: Invalidator;
    resources: ReadonlyMap<string, { extra?: DocumentTags }>;
    autoPurge: boolean;
    purgeOn?: PurgeOn;
  },
): Promise<Array<() => void>> {
  const wantsAuto = opts.autoPurge && opts.resources.size > 0;
  const explicit = Object.entries(opts.purgeOn ?? {});
  if (!wantsAuto && !explicit.length) return [];
  if (!hasEvents(fastify)) {
    if (explicit.length)
      throw new Error(
        "[arc] httpCache.purgeOn needs the events plugin registered before httpCache",
      );
    fastify.log.warn(
      { resources: [...opts.resources.keys()] },
      "httpCache: resources declare httpCache but the events plugin is absent; writes will not purge, entries expire at their TTL",
    );
    return [];
  }
  const off: Array<() => void> = [];
  if (wantsAuto) {
    off.push(
      await fastify.events.subscribe("*", async (event) => {
        const hit = tagsForCrudEvent(event as DomainEvent<unknown>, opts.resources);
        if (hit) opts.invalidator.invalidate(hit.tags, hit.mode);
      }),
    );
  }
  for (const [pattern, toTags] of explicit) {
    off.push(
      await fastify.events.subscribe(pattern, async (event) => {
        const out = toTags(event as DomainEvent<unknown>);
        if (!out) return;
        if (Array.isArray(out)) opts.invalidator.invalidate(out as readonly string[], "hard");
        else {
          const chosen = out as { tags: readonly string[]; mode: PurgeMode };
          opts.invalidator.invalidate(chosen.tags, chosen.mode);
        }
      }),
    );
  }
  return off;
}
