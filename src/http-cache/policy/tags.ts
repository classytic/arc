import type { FastifyRequest } from "fastify";
import type { RouteHttpCacheConfig } from "./policy.types.js";

export const MAX_TAG_LENGTH = 1024;
/** Cloudflare caps the tag header near 16 KB; stay under it so the CDN never drops it. */
export const MAX_TAG_HEADER_LENGTH = 16_000;

/** A tag every major CDN accepts: printable ASCII, no space or comma, at most 1,024 characters; de-duplicated. */
export function normalizeTags(tags: readonly unknown[] | undefined): string[] {
  if (!tags) return [];
  const out = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH || !/^[\x21-\x7e]+$/.test(tag) || tag.includes(","))
      continue;
    out.add(tag);
  }
  return [...out];
}

/** `<resource>` and `<resource>:<id>`: the convention responses carry and purges target. */
export function resourceTags(resource: string, id?: unknown): string[] {
  return id === undefined || id === null || id === ""
    ? [resource]
    : [resource, `${resource}:${String(id)}`];
}

/** The document inside a CRUD reply, enveloped (`{ data }`) or bare. */
export function documentOf(body: unknown): unknown {
  if (body && typeof body === "object" && "data" in body) return (body as { data: unknown }).data;
  return body;
}

/** Every tag a response carries: derived from its resource, then the policy's own. */
export function responseTags(
  policy: RouteHttpCacheConfig,
  request: FastifyRequest,
  body: unknown,
): string[] {
  const tags: unknown[] = [];
  const resource = policy.resource;
  if (resource) {
    const id =
      resource.op === "get"
        ? (request.params as Record<string, unknown> | undefined)?.id
        : undefined;
    tags.push(...resourceTags(resource.name, id));
    if (resource.op === "get" && resource.extra)
      tags.push(...(resource.extra(documentOf(body)) ?? []));
  }
  if (policy.tags) {
    tags.push(
      ...(typeof policy.tags === "function" ? (policy.tags(request, body) ?? []) : policy.tags),
    );
  }
  return normalizeTags(tags);
}

/** Join tags under the header cap; reports how many were dropped. */
export function tagHeaderValue(
  tags: readonly string[],
  separator: string,
): { value: string; dropped: number } {
  let value = "";
  for (let i = 0; i < tags.length; i++) {
    const next = value ? `${value}${separator}${tags[i]}` : (tags[i] as string);
    if (next.length > MAX_TAG_HEADER_LENGTH) return { value, dropped: tags.length - i };
    value = next;
  }
  return { value, dropped: 0 };
}
