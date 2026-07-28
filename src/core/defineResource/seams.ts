/**
 * Resource seams — the typed contract for PROGRAMMATIC resource assembly.
 *
 * `defineResource()` is optimized for literal inline configs. Module authors
 * (arc-* domain packs) assemble configs from host-injected parts instead —
 * and before this file existed, every one of them typed their seam bundles
 * as `unknown` and paid `as never` at each `defineResource` slot (a real
 * arc-catalog module carried 15+ casts in under 200 lines). Every module
 * also reinvented its own spread-merge, and each merge drifted subtly.
 *
 * Two exports close that gap:
 *
 *   - {@link ResourceSeams} — the host-injectable subset of `ResourceConfig`
 *     (everything except `name`), with the `adapter` slot widened through
 *     {@link AdapterLike} so doc-type-erased module boundaries accept any
 *     kit adapter without casts.
 *   - {@link mergeResourceConfig} — the canonical slot-aware merge, so
 *     "module defaults + host seams" composes identically in every module.
 *
 * @example A module builder, cast-free
 * ```typescript
 * export interface CatalogSeams { product?: ResourceSeams }
 *
 * function buildProduct(seams?: ResourceSeams) {
 *   return defineResource(
 *     mergeResourceConfig(
 *       {
 *         name: 'product',
 *         prefix: '/products',
 *         audit: true,
 *         permissions: permissionMatrix({ read: view, write: manage }),
 *       },
 *       seams,
 *     ),
 *   );
 * }
 * ```
 */

import type { DataAdapter } from "@classytic/repo-core/adapter";
import type { AnyRecord, ResourceConfig } from "../../types/index.js";

/**
 * Structural adapter boundary — the `ControllerLike` pattern
 * applied to adapters. `DataAdapter<T>` is invariant in `T`, so a
 * `DataAdapter<HydratedDocument<IProduct>>` built by the HOST does not
 * assign to a module's `DataAdapter<AnyRecord>` slot; before this type,
 * module authors erased the slot to `unknown` and cast at every use.
 *
 * Arc only reaches for these members at runtime — the rest of the adapter's
 * shape is the caller's concern. All slots optional + `unknown` so every
 * kit adapter (mongokit, sqlitekit, prismakit, custom) assigns structurally.
 *
 * Used by {@link ResourceSeams}; `ResourceConfig.adapter` itself stays
 * `DataAdapter<TDoc>` so `defineResource`'s doc-type inference is untouched.
 */
export interface AdapterLike {
  repository?: unknown;
  generateSchemas?: unknown;
  getSchemaMetadata?: unknown;
}

/**
 * Seam-slot type transform, two widenings per property:
 *
 *   - admits explicit `undefined` — {@link mergeResourceConfig} skips
 *     `undefined` values at runtime, so the type says so. Makes
 *     field-mapping seams (`{ permissions: cfg.permissionsMap, ... }`)
 *     ergonomic under `exactOptionalPropertyTypes: true` (stricter than
 *     arc's own tsconfig — found by a live spine-module smoke).
 *   - array slots also accept `readonly` arrays — hosts naturally write
 *     route/preset tables `as const` or behind `readonly` exports; the
 *     merge copies arrays into fresh mutable ones, so a frozen host table
 *     never leaks into arc's internals.
 */
type SeamSlot<V> = V | undefined | (V extends (infer E)[] ? readonly E[] : never);
type SkippableUndefined<T> = { [K in keyof T]: SeamSlot<T[K]> };

/**
 * The host-injectable subset of a resource config — everything a module can
 * let its host override, i.e. every `ResourceConfig` slot except the
 * module-owned `name` (and the internal preset-tracking field).
 *
 * Type your module's per-resource override bundles as `ResourceSeams` (or a
 * `Pick<ResourceSeams, ...>` allow-list when you want to constrain what
 * hosts may touch) and pass them through {@link mergeResourceConfig}.
 */
export type ResourceSeams<TDoc = AnyRecord> = SkippableUndefined<
  Omit<ResourceConfig<TDoc>, "name" | "_appliedPresets" | "adapter">
> & {
  /** Any kit adapter — widened via {@link AdapterLike} at this boundary. */
  adapter?: DataAdapter<TDoc> | AdapterLike | undefined;
};

/**
 * Base-config input for {@link mergeResourceConfig} — a required `name`
 * plus every seam slot (which is exactly `ResourceConfig` with the
 * {@link AdapterLike} widening, `undefined`-skipping, and readonly-array
 * acceptance the seams get). Module builders constructing DEFAULT adapters
 * from untyped kernel engine bags hit the identical `DataAdapter<T>`
 * invariance at the base as hosts do at the seam.
 */
export type SeamedResourceConfig<TDoc = AnyRecord> = { name: string } & ResourceSeams<TDoc>;

/** Plain object test — literals only; class instances must replace, not merge. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursive plain-object merge; nested arrays REPLACE (they're value lists). */
function mergePlain(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergePlain(existing, value) : value;
  }
  return out;
}

/**
 * Canonical slot-aware merge of a base resource config with host seams.
 * Later seams win over earlier ones; `undefined` values never clobber.
 *
 * Merge semantics (value-driven — no per-slot registry to drift):
 *
 *   - **Top-level arrays CONCAT** — `routes`, `middlewares`, `presets`,
 *     `routeGuards`, `disabledRoutes`: additive collections, base first.
 *   - **Plain objects merge recursively** — `permissions`, `actions`,
 *     `schemaOptions` (incl. `fieldRules`), `aggregations`, `customSchemas`,
 *     `fields`, `cache`, `events`: per-key composition. Arrays NESTED inside
 *     them replace (they're value lists — enums, sort specs), not concat.
 *   - **Everything else last-wins** — class instances (`adapter`,
 *     `controller`, `queryParser`), functions, scalars.
 *
 * The single `as` at the return is the one documented erasure for the
 * {@link AdapterLike}-widened seam slots — inside the helper so no module
 * author ever writes one (mirrors mongokit's one-cast-at-the-boundary rule).
 */
export function mergeResourceConfig<TDoc = AnyRecord>(
  base: SeamedResourceConfig<TDoc>,
  ...seams: ReadonlyArray<ResourceSeams<TDoc> | undefined>
): ResourceConfig<TDoc> {
  const out: Record<string, unknown> = { ...base };
  for (const seam of seams) {
    if (!seam) continue;
    for (const [key, value] of Object.entries(seam)) {
      if (value === undefined) continue;
      const existing = out[key];
      if (Array.isArray(existing) && Array.isArray(value)) {
        out[key] = [...existing, ...value];
      } else if (isPlainObject(existing) && isPlainObject(value)) {
        out[key] = mergePlain(existing, value);
      } else if (Array.isArray(value)) {
        // Fresh copy even without a base counterpart — seam arrays may be
        // `readonly`/frozen host tables and must never reach arc's mutable
        // internals by reference.
        out[key] = [...value];
      } else {
        out[key] = value;
      }
    }
  }
  return out as unknown as ResourceConfig<TDoc>;
}
