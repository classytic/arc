/**
 * SCIM 2.0 resource route mounting (RFC 7644 §3.4 — §3.6)
 *
 * Routes call the canonical `RepositoryLike` contract from
 * `@classytic/repo-core/adapter` directly. SCIM does NOT introduce its own
 * controller layer — whatever kit plugins (audit, multi-tenant, field-policy)
 * the host wires at construction time fire here the same way they fire for
 * arc REST, because both surfaces hit the same repository methods.
 *
 * **PATCH** uses `findOneAndUpdate(filter, ops)` so operator-shaped updates
 * ($set / $unset / $push / $pull) flow through unchanged. mongokit applies
 * them natively; sqlitekit accepts $set/$unset (`UpdateSpec`) but rejects
 * $push/$pull on JSON columns — this route surfaces 400 in that case rather
 * than silently dropping the operation. Kits without `findOneAndUpdate`
 * fall back to `update(id, $set-only)` so basic SCIM PATCH still works.
 *
 * **PUT** uses `bulkWrite([{ replaceOne }])` because full-document replace
 * is not in `MinimalRepo`. Kits that don't expose `bulkWrite` 501 with a
 * clear message — no silent merge into `update(id, partial)`.
 *
 * **Observability**: every request emits one `ScimObservedEvent` (status,
 * duration, op, path) routed through the plugin's `observe` callback or
 * `request.log.info(...)` by default.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from "fastify";
import { ScimError } from "./errors.js";
import { parseScimFilter } from "./filter.js";
import {
  asRecord,
  hasBulkWrite,
  hasFindOneAndUpdate,
  type MountedResource,
  sendScimError,
  unwrapList,
} from "./helpers.js";
import { resourceToScim, scimToResource } from "./mapping.js";
import { parseScimPatch } from "./patch.js";
import type { ScimObservedEvent } from "./types.js";

type ObserveFn = (event: ScimObservedEvent) => void;

/**
 * Wrap a route body so every outcome (success, ScimError, unknown error)
 * funnels through one observability path. Generic over the request type so
 * Fastify's route-shape generics (`<{ Params, Body, Querystring }>`) narrow
 * `request.params` / `request.body` natively — no `as FastifyRequest & {...}`
 * casts at call sites.
 */
function withObserve<RG extends RouteGenericInterface = RouteGenericInterface>(
  fastify: FastifyInstance,
  observe: ObserveFn,
  resourceType: ScimObservedEvent["resourceType"],
  op: string,
  path: string,
  body: (req: FastifyRequest<RG>) => Promise<{
    status: number;
    payload?: unknown;
    headers?: Record<string, string>;
  }>,
): (request: FastifyRequest<RG>, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    const start = Date.now();
    try {
      const result = await body(request);
      reply.code(result.status).header("Content-Type", "application/scim+json");
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
      }
      observe({
        resourceType,
        op,
        status: result.status,
        durationMs: Date.now() - start,
        path,
      });
      return result.payload === undefined ? reply.send() : reply.send(result.payload);
    } catch (err) {
      const scim = err instanceof ScimError ? err : null;
      observe({
        resourceType,
        op,
        status: scim?.statusCode ?? 500,
        durationMs: Date.now() - start,
        scimType: scim?.scimType,
        path,
      });
      fastify.log?.warn?.({ err, resourceType, op, path }, "SCIM request failed");
      return sendScimError(reply, err);
    }
  };
}

/**
 * Build a backend-shaped patch from SCIM ops, mapping SCIM attribute names
 * onto backend field names per the resource's mapping. Returns canonical
 * Mongo-style operators that flow through `findOneAndUpdate` unchanged.
 *
 * Returns `null` when the SCIM body parses but contains nothing the kit can
 * apply through the canonical contract — caller surfaces 400 in that case.
 */
function scimOpsToBackendOps(
  scimOps: ReturnType<typeof parseScimPatch>,
  attrMap: Record<string, string>,
): {
  ops: Record<string, unknown>;
  hasArrayOps: boolean;
  arrayOpFields: string[];
} {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, true> = {};
  const $push: Record<string, unknown> = {};
  const $pull: Record<string, unknown> = {};

  const map = (scimAttr: string): string => attrMap[scimAttr] ?? scimAttr;

  for (const [scimAttr, value] of Object.entries(scimOps.$set)) {
    $set[map(scimAttr)] = value;
  }
  for (const scimAttr of Object.keys(scimOps.$unset)) {
    $unset[map(scimAttr)] = true;
  }
  for (const [scimAttr, value] of Object.entries(scimOps.$push)) {
    $push[map(scimAttr)] = value;
  }
  for (const [scimAttr, value] of Object.entries(scimOps.$pull)) {
    $pull[map(scimAttr)] = value;
  }

  const ops: Record<string, unknown> = {};
  if (Object.keys($set).length > 0) ops.$set = $set;
  if (Object.keys($unset).length > 0) ops.$unset = $unset;
  if (Object.keys($push).length > 0) ops.$push = $push;
  if (Object.keys($pull).length > 0) ops.$pull = $pull;

  return {
    ops,
    hasArrayOps: Object.keys($push).length > 0 || Object.keys($pull).length > 0,
    arrayOpFields: [...Object.keys($push), ...Object.keys($pull)],
  };
}

/** Pluck the id field a kit wrote on the document, accepting `id` or `_id`. */
function extractId(doc: Record<string, unknown>): string {
  const raw = doc.id ?? doc._id;
  return raw == null ? "" : String(raw);
}

/**
 * Mount the canonical SCIM CRUD surface for one resource type (Users /
 * Groups) under the plugin's prefix. Authentication is enforced inside
 * each handler so the observability span captures auth failures too.
 */
export function mountResourceRoutes(
  fastify: FastifyInstance,
  resourceTypeName: "Users" | "Groups",
  mounted: MountedResource,
  authCheck: (request: FastifyRequest) => Promise<void>,
  maxResults: number,
  observe: ObserveFn,
): void {
  const prefix = mounted.basePath;
  const repo = mounted.binding.resource.adapter.repository;
  const mapping = mounted.mapping;

  // Mapper: SCIM attr → backend field for filter parser. Falls back to the
  // raw attr name so backend-named columns (anything not in the mapping)
  // still flow through. Filter parser only 400s when a downstream consumer
  // returns undefined; this never does — that's by design for SCIM, where
  // hosts often filter on columns they didn't map.
  const filterMapper = (attr: string): string => mapping.attributes[attr] ?? attr;

  // Lift baseUrl + resourceToScim into one closure so every route stops
  // re-computing `${protocol}://${hostname}${prefix}` and re-passing
  // `mapping`. Future forwarded-host handling lands here too.
  const toScim = (doc: unknown, request: FastifyRequest): Record<string, unknown> =>
    resourceToScim(asRecord(doc), mapping, `${request.protocol}://${request.hostname}${prefix}`);

  // Detect kit capabilities once per mount — used in PATCH / PUT routes
  // for honest degradation paths.
  const supportsOperators = hasFindOneAndUpdate(repo);
  const supportsReplace = hasBulkWrite(repo);

  const notFound = (): ScimError =>
    new ScimError(404, undefined, `${resourceTypeName.slice(0, -1)} not found`);

  // Route-shape types — declared once so `fastify.X<T>(...)` and
  // `withObserve<T>(...)` reference the same name (no schema duplication,
  // no `as FastifyRequest & {...}` casts inside the body closures).
  type ListRoute = {
    Querystring: {
      filter?: string;
      startIndex?: string;
      count?: string;
      attributes?: string;
      sortBy?: string;
      sortOrder?: "ascending" | "descending";
    };
  };
  type IdRoute = { Params: { id: string } };
  type CreateRoute = { Body: Record<string, unknown> };
  type IdBodyRoute = { Params: { id: string }; Body: Record<string, unknown> };

  // PATCH apply strategy — feature-detect once at mount, dispatch through
  // a uniform shape per request. Operator-capable kits get the full PATCH;
  // MinimalRepo-only kits get $set-only with explicit 400 on $unset / array
  // ops (silent drop would be the original bug).
  type PatchOps = ReturnType<typeof scimOpsToBackendOps>;
  const applyPatch: (
    id: string,
    p: PatchOps,
    raw: ReturnType<typeof parseScimPatch>,
  ) => Promise<unknown> = supportsOperators
    ? async (id, p) => {
        try {
          return await repo.findOneAndUpdate({ id }, p.ops);
        } catch (err) {
          if (p.hasArrayOps) {
            throw new ScimError(
              400,
              "invalidValue",
              `Array mutations ($push/$pull) on field(s) ${p.arrayOpFields.join(", ")} ` +
                `are not supported by this kit's repository. Use a kit with native ` +
                `array-column support (e.g. @classytic/mongokit), or replace the field ` +
                `wholesale via PUT. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          throw err;
        }
      }
    : async (id, p, raw) => {
        if (Object.keys(raw.$unset).length > 0 || p.hasArrayOps) {
          throw new ScimError(
            400,
            "invalidValue",
            "This kit's repository does not implement findOneAndUpdate; only " +
              "$set-shaped PATCH operations are supported. Drop $unset / $push / $pull " +
              "from the request, or use a kit that exposes findOneAndUpdate.",
          );
        }
        const setData = (p.ops.$set as Record<string, unknown>) ?? {};
        if (Object.keys(setData).length === 0) {
          // No-op patch — RFC 7644 returns 200 with current state.
          return repo.getById(id);
        }
        return repo.update(id, setData);
      };

  // ── LIST ─────────────────────────────────────────────────────
  fastify.get<ListRoute>(
    `${prefix}/${resourceTypeName}`,
    withObserve<ListRoute>(
      fastify,
      observe,
      resourceTypeName,
      "list",
      `/${resourceTypeName}`,
      async (request) => {
        await authCheck(request);
        const q = request.query;
        const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? "1", 10) || 1);
        const count = Math.min(maxResults, Number.parseInt(q.count ?? "100", 10) || 100);
        const filters = q.filter ? parseScimFilter(q.filter, filterMapper) : {};
        const sort: Record<string, 1 | -1> | undefined = q.sortBy
          ? { [filterMapper(q.sortBy)]: q.sortOrder === "descending" ? -1 : 1 }
          : undefined;

        const result = await repo.getAll({
          filters,
          page: Math.floor((startIndex - 1) / count) + 1,
          limit: count,
          sort,
        });
        const { items, total } = unwrapList(result);
        const resources = items.map((item) => toScim(item, request));

        return {
          status: 200,
          payload: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
            totalResults: total,
            startIndex,
            itemsPerPage: resources.length,
            Resources: resources,
          },
        };
      },
    ),
  );

  // ── GET single ───────────────────────────────────────────────
  fastify.get<IdRoute>(
    `${prefix}/${resourceTypeName}/:id`,
    withObserve<IdRoute>(
      fastify,
      observe,
      resourceTypeName,
      "get",
      `/${resourceTypeName}/:id`,
      async (request) => {
        await authCheck(request);
        const doc = await repo.getById(request.params.id);
        if (!doc) throw notFound();
        return { status: 200, payload: toScim(doc, request) };
      },
    ),
  );

  // ── CREATE ───────────────────────────────────────────────────
  fastify.post<CreateRoute>(
    `${prefix}/${resourceTypeName}`,
    withObserve<CreateRoute>(
      fastify,
      observe,
      resourceTypeName,
      "create",
      `/${resourceTypeName}`,
      async (request) => {
        await authCheck(request);
        const data = scimToResource(request.body ?? {}, mapping);
        const created = (await repo.create(data)) as Record<string, unknown>;
        const id = extractId(asRecord(created));
        const baseUrl = `${request.protocol}://${request.hostname}${prefix}`;
        return {
          status: 201,
          payload: toScim(created, request),
          headers: { Location: `${baseUrl}/${resourceTypeName}/${id}` },
        };
      },
    ),
  );

  // ── PUT (full replace via bulkWrite/replaceOne) ──────────────
  // Full-document replacement is NOT in MinimalRepo; only reachable via
  // `bulkWrite([{ replaceOne: { filter, replacement } }])`. Kits without
  // bulkWrite 501 — silent fallback into `update(id, partial)` would mean
  // omitted fields survive, which violates SCIM PUT contract.
  fastify.put<IdBodyRoute>(
    `${prefix}/${resourceTypeName}/:id`,
    withObserve<IdBodyRoute>(
      fastify,
      observe,
      resourceTypeName,
      "replace",
      `/${resourceTypeName}/:id`,
      async (request) => {
        await authCheck(request);
        if (!supportsReplace) {
          throw new ScimError(
            501,
            undefined,
            "Full replacement (PUT) requires the underlying repository to expose " +
              "bulkWrite([{ replaceOne }]). This kit does not implement bulkWrite. " +
              "Use PATCH to apply partial updates instead.",
          );
        }
        const data = scimToResource(request.body ?? {}, mapping);
        await repo.bulkWrite([
          {
            replaceOne: {
              filter: { id: request.params.id },
              replacement: data as Record<string, unknown>,
            },
          },
        ]);
        // Re-fetch — bulkWrite returns a summary, not the doc. The 404 here
        // covers both "didn't exist before" and "didn't exist after"; bulkWrite's
        // matchedCount is kit-specific, so the canonical check is the read.
        const updated = await repo.getById(request.params.id);
        if (!updated) throw notFound();
        return { status: 200, payload: toScim(updated, request) };
      },
    ),
  );

  // ── PATCH (RFC 7644 PatchOp) ──────────────────────────────────
  fastify.patch<IdBodyRoute>(
    `${prefix}/${resourceTypeName}/:id`,
    withObserve<IdBodyRoute>(
      fastify,
      observe,
      resourceTypeName,
      "patch",
      `/${resourceTypeName}/:id`,
      async (request) => {
        await authCheck(request);
        const scimOps = parseScimPatch(request.body as Record<string, unknown>);
        const patchOps = scimOpsToBackendOps(scimOps, mapping.attributes);
        const updated = (await applyPatch(request.params.id, patchOps, scimOps)) as Record<
          string,
          unknown
        > | null;
        if (!updated) throw notFound();
        return { status: 200, payload: toScim(updated, request) };
      },
    ),
  );

  // ── DELETE (deprovision) ──────────────────────────────────────
  fastify.delete<IdRoute>(
    `${prefix}/${resourceTypeName}/:id`,
    withObserve<IdRoute>(
      fastify,
      observe,
      resourceTypeName,
      "delete",
      `/${resourceTypeName}/:id`,
      async (request) => {
        await authCheck(request);
        await repo.delete(request.params.id);
        return { status: 204 };
      },
    ),
  );
}
