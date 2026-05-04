/**
 * SCIM 2.0 plugin internals — auth, mapping merge, response shape detection
 *
 * Internal helpers shared by `routes.ts` and `discovery.ts`.
 */

import type { RepositoryLike } from "@classytic/repo-core/adapter";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ScimError } from "./errors.js";
import type { ScimResourceMapping } from "./mapping.js";
import type { ScimPluginOptions, ScimResourceBinding } from "./types.js";

/**
 * Internal context passed to per-resource route mounts. Threading it through
 * one shape keeps `routes.ts` from rebuilding state per route.
 */
export interface MountedResource {
  binding: ScimResourceBinding;
  mapping: ScimResourceMapping;
  basePath: string;
}

/** Combine plugin defaults with the host's per-resource mapping override. */
export function mergeMapping(
  defaults: ScimResourceMapping,
  override?: Partial<ScimResourceMapping>,
): ScimResourceMapping {
  if (!override) return defaults;
  return {
    schema: override.schema ?? defaults.schema,
    attributes: { ...defaults.attributes, ...(override.attributes ?? {}) },
    reverseAttributes: override.reverseAttributes,
    fromScim: override.fromScim ?? defaults.fromScim,
    toScim: override.toScim ?? defaults.toScim,
  };
}

/**
 * Build the per-request auth check from `bearer` (static) or `verify` (callback).
 * Throws at plugin construction if both / neither are configured.
 */
export function makeAuthCheck(opts: ScimPluginOptions): (request: FastifyRequest) => Promise<void> {
  if (opts.bearer && opts.verify) {
    throw new Error("scimPlugin: pass either `bearer` or `verify`, not both");
  }
  if (opts.bearer) {
    const expected = `Bearer ${opts.bearer}`;
    return async (request) => {
      const auth = request.headers.authorization;
      if (auth !== expected) throw new ScimError(401, undefined, "Invalid bearer token");
    };
  }
  if (opts.verify) {
    const verify = opts.verify;
    return async (request) => {
      const ok = await verify(request);
      if (!ok) throw new ScimError(401, undefined, "SCIM authentication failed");
    };
  }
  throw new Error("scimPlugin: configure either `bearer` (static token) or `verify` (callback)");
}

/**
 * Format any thrown value into the canonical SCIM 2.0 error envelope and
 * write it to the reply. Always sends `application/scim+json`.
 */
export function sendScimError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ScimError) {
    return reply
      .code(err.statusCode)
      .header("Content-Type", "application/scim+json")
      .send(err.toResponse());
  }
  const fallback = new ScimError(
    500,
    undefined,
    err instanceof Error ? err.message : "Internal SCIM error",
  );
  return reply
    .code(fallback.statusCode)
    .header("Content-Type", "application/scim+json")
    .send(fallback.toResponse());
}

/**
 * Repos return one of three list shapes today — direct array (raw repos),
 * canonical `{ method, data, total }` (repo-core 0.5+), or legacy
 * `{ docs, total }`. Accept all three so the SCIM plugin doesn't pin to a
 * specific kit version.
 */
interface AnyListResponse {
  method?: string;
  data?: unknown[];
  total?: number;
  docs?: unknown[];
}

export function unwrapList(result: unknown): { items: unknown[]; total: number } {
  if (Array.isArray(result)) return { items: result, total: result.length };
  if (result && typeof result === "object") {
    const r = result as AnyListResponse;
    if (Array.isArray(r.data)) return { items: r.data, total: r.total ?? r.data.length };
    if (Array.isArray(r.docs)) return { items: r.docs, total: r.total ?? r.docs.length };
  }
  return { items: [], total: 0 };
}

/** Coerce a Mongoose / Drizzle / plain doc to a plain `Record`. */
export function asRecord(doc: unknown): Record<string, unknown> {
  if (!doc || typeof doc !== "object") return {};
  if (typeof (doc as { toObject?: () => unknown }).toObject === "function") {
    return (doc as { toObject: () => Record<string, unknown> }).toObject();
  }
  return doc as Record<string, unknown>;
}

/**
 * Register the `application/scim+json` Fastify content-type parser. Idempotent
 * — second registration in the same scope is a no-op. Empty bodies (DELETE,
 * GET) yield `undefined` rather than crashing on `JSON.parse("")`.
 */
export function ensureScimContentTypeParser(fastify: import("fastify").FastifyInstance): void {
  if (fastify.hasContentTypeParser("application/scim+json")) return;
  fastify.addContentTypeParser(
    "application/scim+json",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = body as string;
      if (!raw || raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// Repository feature detection — used by routes.ts to honestly degrade
// PATCH (operator-aware) and PUT (replace) when the kit doesn't expose
// the underlying op.
// ─────────────────────────────────────────────────────────────────────

/**
 * Does the repo expose `findOneAndUpdate` (StandardRepo optional)? Required
 * for SCIM PATCH because operator-shaped updates ($set / $unset / $push /
 * $pull) need to flow through unchanged.
 */
export function hasFindOneAndUpdate(repo: RepositoryLike): repo is RepositoryLike & {
  findOneAndUpdate: NonNullable<RepositoryLike["findOneAndUpdate"]>;
} {
  return typeof (repo as { findOneAndUpdate?: unknown }).findOneAndUpdate === "function";
}

/**
 * Does the repo expose `bulkWrite` with `replaceOne` support? Required for
 * SCIM PUT — full document replacement is not in MinimalRepo, only reachable
 * via `bulkWrite([{ replaceOne }])`.
 */
export function hasBulkWrite(repo: RepositoryLike): repo is RepositoryLike & {
  bulkWrite: NonNullable<RepositoryLike["bulkWrite"]>;
} {
  return typeof (repo as { bulkWrite?: unknown }).bulkWrite === "function";
}
