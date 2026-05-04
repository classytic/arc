/**
 * defineResourceVariants — Define multiple resources sharing one model/repo/adapter.
 *
 * Common pattern: the same underlying data exposed through two different
 * HTTP interfaces. For example:
 *
 *   - Public: `GET /articles/:slug` (read-only, slug-keyed, allowPublic)
 *   - Admin:  `CRUD /admin/articles/:_id` (full CRUD, _id-keyed, requireRoles)
 *
 * Doing this with two separate `defineResource()` calls duplicates the shared
 * config (adapter, queryParser, schemaOptions). This helper takes a base
 * config + a map of variant overrides and returns a record of named
 * `ResourceDefinition`s, one per variant.
 *
 * The base + override pattern intentionally mirrors `defineResource()` itself —
 * the helper is just sugar that returns N real resources. Each variant goes
 * through `defineResource()` independently, so presets, hooks, registry
 * registration, and OpenAPI generation all work normally.
 *
 * @example
 * ```typescript
 * import { Repository } from '@classytic/mongokit';
 * import { createMongooseAdapter } from '@classytic/mongokit/adapter';
 * import { defineResourceVariants } from '@classytic/arc';
 * import { allowPublic, adminOnly, readOnly } from '@classytic/arc/permissions';
 * import { ArticleModel, type IArticle } from './article.model.js';
 *
 * const repo = new Repository<IArticle>(ArticleModel);
 * const adapter = createMongooseAdapter({ model: ArticleModel, repository: repo });
 *
 * export const { articlePublic, articleAdmin } = defineResourceVariants<IArticle>(
 *   { adapter },
 *   {
 *     articlePublic: {
 *       name: 'article',
 *       prefix: '/articles',
 *       idField: 'slug',
 *       disabledRoutes: ['create', 'update', 'delete'],
 *       permissions: readOnly(),
 *     },
 *     articleAdmin: {
 *       name: 'article-admin',
 *       prefix: '/admin/articles',
 *       permissions: adminOnly(),
 *     },
 *   },
 * );
 * ```
 *
 * Each variant must declare its own `name` (registry uniqueness) and `prefix`
 * (route uniqueness). Everything else falls back to the base.
 */

import type { AnyRecord, ResourceConfig } from "../types/index.js";
import { defineResource, type ResourceDefinition } from "./defineResource.js";

/**
 * Required identity fields for each variant. The user MUST provide a unique
 * `name` (registry collision prevention) and a unique `prefix` (route
 * collision prevention) for every variant.
 */
type VariantIdentity = Required<Pick<ResourceConfig, "name" | "prefix">>;

/**
 * A variant override = identity (name + prefix) + any other ResourceConfig
 * field that should differ from the base.
 */
type VariantOverride<TDoc = AnyRecord> = VariantIdentity & Partial<ResourceConfig<TDoc>>;

/**
 * Map of variant key → override config. The key becomes the property name in
 * the returned object (e.g. `{ articlePublic: ... }` → `result.articlePublic`).
 */
type VariantsMap<TDoc = AnyRecord> = Record<string, VariantOverride<TDoc>>;

/**
 * Result type — preserves the variant keys so destructuring is type-safe:
 * `const { articlePublic, articleAdmin } = defineResourceVariants(...)`.
 */
type VariantsResult<TDoc, V extends VariantsMap<TDoc>> = {
  [K in keyof V]: ResourceDefinition<TDoc>;
};

/**
 * Define multiple resources from a shared base config and per-variant overrides.
 *
 * Each variant is independently passed through `defineResource()` — the
 * returned `ResourceDefinition`s are real, fully-registered resources.
 * Register each one's plugin in your app:
 *
 * ```typescript
 * await app.register(articlePublic.toPlugin());
 * await app.register(articleAdmin.toPlugin());
 * ```
 *
 * @param base    Shared config — adapter, queryParser, schemaOptions, hooks, etc.
 *                Must NOT include `name` or `prefix` (those are per-variant).
 * @param variants  Map of variant key → override. Each variant must declare
 *                  its own `name` and `prefix`. Other fields override the base.
 * @returns A record where each key from `variants` maps to a real
 *          `ResourceDefinition` ready for `.toPlugin()` registration.
 */
export function defineResourceVariants<
  TDoc extends AnyRecord = AnyRecord,
  V extends VariantsMap<TDoc> = VariantsMap<TDoc>,
>(base: Omit<ResourceConfig<TDoc>, "name" | "prefix">, variants: V): VariantsResult<TDoc, V> {
  const out = {} as VariantsResult<TDoc, V>;
  for (const key of Object.keys(variants) as Array<keyof V>) {
    const override = variants[key] as VariantOverride<TDoc>;
    out[key] = defineResource<TDoc>({
      ...(base as ResourceConfig<TDoc>),
      ...override,
    } as ResourceConfig<TDoc>);
  }
  return out;
}
