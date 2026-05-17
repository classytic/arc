/**
 * Resource manifest for frontend code generators (v2.15.5).
 *
 * Every host that hand-rolls a `createCrudApi('foo')` helper on the frontend
 * ends up rewriting the same shim for declarative actions: `postAction(id,
 * name, body)` — and forgets to add a method for every NEW action declared
 * on the resource. The OpenAI-team report flagged this in fajr's
 * `invoices.js`, and now matches needs the same.
 *
 * Arc owns the resource definition, so arc can ship the metadata FE codegen
 * needs in one canonical shape:
 *
 *   {
 *     name: 'invoice',
 *     prefix: '/invoices',
 *     idField: '_id',
 *     crudOps: ['list', 'get', 'create', 'update', 'delete'],
 *     actions: [
 *       { name: 'recordPayment', mount: '/:id/action', requiresId: true,  description: '...' },
 *       { name: 'propose',       mount: '/action',     requiresId: false, description: '...' },
 *     ],
 *   }
 *
 * Hosts feed this into their FE generator (or a runtime `createActionsApi`
 * shim) and every action is wired automatically. New actions land on the FE
 * the same moment they're declared on the resource — no parallel list to
 * keep in sync.
 *
 * The helper is BE-side only (lives under `@classytic/arc/registry`) — arc
 * stays a backend framework and doesn't ship FE runtime code. The host
 * decides whether the manifest powers a fetch-based helper, a TanStack
 * Query factory, an RPC client, or static `.d.ts` generation.
 *
 * @example BE → emit JSON at build time / on a route
 * ```ts
 * // Build-time codegen
 * import { buildResourceManifest } from '@classytic/arc/registry';
 * import { invoiceResource } from './invoice.resource.js';
 * writeFileSync('./fe-gen/invoice.manifest.json',
 *   JSON.stringify(buildResourceManifest(invoiceResource)));
 *
 * // Runtime introspection endpoint
 * fastify.get('/manifest/:name', async (req) => {
 *   const r = arc.registry.get(req.params.name);
 *   return r ? buildResourceManifestFromRegistry(r) : reply.code(404);
 * });
 * ```
 *
 * @example FE → generate fetch methods from the manifest
 * ```ts
 * import manifest from './fe-gen/invoice.manifest.json';
 * import { createActionsApi } from './my-fe-shim.js';  // host-owned
 *
 * export const invoicesApi = {
 *   ...createCrudApi(manifest.prefix),
 *   ...createActionsApi(manifest.prefix, manifest.actions),
 *   // → invoicesApi.recordPayment(id, body)
 *   // → invoicesApi.propose(body)        // id-less
 * };
 * ```
 */

import { CRUD_OPERATIONS, DEFAULT_ID_FIELD, DEFAULT_UPDATE_METHOD } from "../constants.js";
import type { ResourceDefinition } from "../core/defineResource.js";
import type { CrudRouteKey, RegistryEntry } from "../types/index.js";

// ============================================================================
// Manifest shape
// ============================================================================

/** Mount-point string the FE uses to derive the URL for an action call. */
export type ActionMount = "/:id/action" | "/action";

/**
 * One action entry in a resource manifest. `requiresId` is the boolean
 * the FE checks to decide whether its helper takes `(id, body)` or just
 * `(body)`; `mount` is the URL suffix to append to the resource prefix.
 */
export interface ActionManifestEntry {
  readonly name: string;
  readonly mount: ActionMount;
  readonly requiresId: boolean;
  readonly description?: string;
}

/** Aggregation entry — one per `defineAggregation()` declaration. */
export interface AggregationManifestEntry {
  readonly name: string;
  readonly path: string;
  readonly summary?: string;
  readonly description?: string;
}

/** Custom (non-CRUD, non-action) route entry. */
export interface CustomRouteManifestEntry {
  readonly method: string;
  readonly path: string;
  readonly operation?: string;
  readonly summary?: string;
}

/**
 * Single resource manifest. Everything an FE codegen needs to wire a
 * typed client over the resource's HTTP surface.
 */
export interface ResourceManifest {
  readonly name: string;
  readonly displayName: string;
  readonly prefix: string;
  readonly idField: string;
  /** Update method used for `/:id` PATCH / PUT routes. */
  readonly updateMethod: "PUT" | "PATCH" | "both";
  /** Enabled CRUD operations — filtered by `disabledRoutes` and `disableDefaultRoutes`. */
  readonly crudOps: readonly CrudRouteKey[];
  readonly actions: readonly ActionManifestEntry[];
  readonly aggregations: readonly AggregationManifestEntry[];
  readonly customRoutes: readonly CustomRouteManifestEntry[];
  /** Tenant scoping field (when set) — surfaces for FE callers that need to send `x-organization-id`. */
  readonly tenantField?: string | false;
}

// ============================================================================
// Builders — one for live `ResourceDefinition`, one for registry entries
// ============================================================================

/**
 * Build a manifest from a `ResourceDefinition` (the value returned by
 * `defineResource(...)`). Use at build time when you have direct access
 * to the resource module — typically the simplest codegen path.
 */
export function buildResourceManifest(resource: ResourceDefinition): ResourceManifest {
  const disabled = new Set(resource.disabledRoutes ?? []);
  const crudOps: CrudRouteKey[] = resource.disableDefaultRoutes
    ? []
    : (CRUD_OPERATIONS.filter((op) => !disabled.has(op)) as CrudRouteKey[]);

  const actions: ActionManifestEntry[] = [];
  for (const [name, entry] of Object.entries(resource.actions ?? {})) {
    // 2.15.5 — function-shorthand actions are always id-bound (legacy
    // default). Only object-form definitions can opt out via `id: false`.
    const requiresId = typeof entry === "function" ? true : entry.id !== false;
    actions.push({
      name,
      mount: requiresId ? "/:id/action" : "/action",
      requiresId,
      ...(typeof entry !== "function" && entry.description
        ? { description: entry.description }
        : {}),
    });
  }

  const aggregations: AggregationManifestEntry[] = [];
  for (const [name, agg] of Object.entries(resource.aggregations ?? {})) {
    aggregations.push({
      name,
      path: `${resource.prefix}/aggregations/${name}`,
      ...(agg.summary ? { summary: agg.summary } : {}),
      ...(agg.description ? { description: agg.description } : {}),
    });
  }

  const customRoutes: CustomRouteManifestEntry[] = [];
  for (const route of resource.routes ?? []) {
    customRoutes.push({
      method: route.method,
      path: `${resource.prefix}${route.path}`,
      ...(route.operation ? { operation: route.operation } : {}),
      ...(route.summary ? { summary: route.summary } : {}),
    });
  }

  return {
    name: resource.name,
    displayName: resource.displayName,
    prefix: resource.prefix,
    idField: resource.idField ?? DEFAULT_ID_FIELD,
    updateMethod: resource.updateMethod ?? DEFAULT_UPDATE_METHOD,
    crudOps,
    actions,
    aggregations,
    customRoutes,
    ...(resource.tenantField !== undefined ? { tenantField: resource.tenantField } : {}),
  };
}

/**
 * Build a manifest from a `RegistryEntry` — use when the resource is
 * already registered (introspection endpoint, runtime audit script).
 *
 * Equivalent to {@link buildResourceManifest} but reads from the projected
 * registry shape, so a host that doesn't have the original `defineResource`
 * value in scope (e.g. an FE-gen sidecar that scrapes a running server's
 * `/_resources` endpoint) gets the same output without dragging the resource
 * module into the codegen path.
 */
export function buildResourceManifestFromRegistry(entry: RegistryEntry): ResourceManifest {
  const disabled = new Set(entry.disabledRoutes ?? []);
  const crudOps: CrudRouteKey[] = entry.disableDefaultRoutes
    ? []
    : (CRUD_OPERATIONS.filter((op) => !disabled.has(op)) as CrudRouteKey[]);

  const actions: ActionManifestEntry[] = (entry.actions ?? []).map((a) => {
    const requiresId = a.id !== false;
    return {
      name: a.name,
      mount: requiresId ? "/:id/action" : "/action",
      requiresId,
      ...(a.description ? { description: a.description } : {}),
    };
  });

  const aggregations: AggregationManifestEntry[] = (entry.aggregations ?? []).map((agg) => ({
    name: agg.name,
    path: `${entry.prefix}/aggregations/${agg.name}`,
    ...(agg.summary ? { summary: agg.summary } : {}),
    ...(agg.description ? { description: agg.description } : {}),
  }));

  const customRoutes: CustomRouteManifestEntry[] = (entry.customRoutes ?? []).map((r) => ({
    method: r.method,
    path: `${entry.prefix}${r.path}`,
    ...(r.operation ? { operation: r.operation } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
  }));

  // updateMethod on RegistryEntry is `"PUT" | "PATCH" | "both" | undefined`;
  // fall back to the canonical default so the manifest always carries a
  // resolved value (FE codegen shouldn't have to repeat the lookup).
  const updateMethod = entry.updateMethod ?? DEFAULT_UPDATE_METHOD;

  return {
    name: entry.name,
    displayName: entry.displayName ?? entry.name,
    prefix: entry.prefix,
    // `idField` isn't on the registry entry today (it's resource-only) —
    // codegen consumers that need it should call `buildResourceManifest`
    // with the live `ResourceDefinition` instead. Default for the registry
    // path is the framework convention.
    idField: DEFAULT_ID_FIELD,
    updateMethod,
    crudOps,
    actions,
    aggregations,
    customRoutes,
    ...(entry.tenantField !== undefined ? { tenantField: entry.tenantField } : {}),
  };
}
